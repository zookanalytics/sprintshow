// The screenshot driver: drive a demo script's steps, check each step's proof, and save
// the state the last step leaves as one PNG. The steps run through the step runner the
// video drivers use, so a proof means the same thing in a screenshot as in a video.
//
// It draws no caption, pointer, cover or scrutiny card, and it needs neither ffmpeg nor
// a narration key. A failed proof does not stop the capture: the PNG is still saved,
// because it shows what failed.
//
// Like the proof driver it takes a ready page, so it owns neither the browser nor the
// server. The device scale factor belongs to the page's context, so the caller sets it
// where the page is created; `runScreenshot` (run.ts) does that for the CLI.
//
// A terminal script's PNG is the terminal window, not the viewport. The terminal page
// paints nothing around the window, and the default white background is always left
// out, so the window's rounded corners are transparent. With `fullPage`, the window holds
// the whole session instead of the screen.
//
// Chromium draws a capture in tiles and holds only so many of them, so a full-page
// capture holds no more than it draws whole (captureHeightLimit). A page keeps its top,
// and a terminal session its last lines. specs/ss-vyii/capture-limit.md records how the
// limit was found.

import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, type Demo } from './demo-script.ts';
import { runStep, openSurface, ACTION_TIMEOUT, VIEWPORT } from './browser.ts';
import { expandToSession, TERMINAL_WINDOW } from './terminal.ts';

/**
 * Chromium rasterizes a capture in square tiles, each laid two device pixels short of its
 * size so that it overlaps the next, and holds at most 512 MiB of them, at 4 bytes a
 * pixel. That is its least on a desktop host, and a larger screen raises it. A tile is
 * 256 pixels on a side, so 2048 of them fit. On macOS and ChromeOS, a browser started on
 * a screen at scale 2 or more draws in tiles of 512 pixels, and only 512 of them fit. A
 * page cannot tell which size its browser draws in, so a capture is held to what both
 * draw. A capture that spans more comes out with the tiles past the budget unpainted,
 * transparent in a terminal still and the page's background in a page capture. A capture
 * that stops above the end of the page is sometimes drawn up to 24 tiles short of the
 * budget, so a capture spends at most 15/16 of it.
 */
const TILE_SIZES = [256, 512];
const TILE_MEMORY = 512 * 1024 * 1024;
/** The time a capture is given for each 256-pixel tile it spans, on top of ACTION_TIMEOUT: rasterizing and encoding it take time in proportion to its area. */
const TILE_TIME_MS = 100;

/** The tiles of `size` device pixels that `length` CSS pixels of a capture span, from the page's edge, at `scale` device pixels per CSS pixel. */
function tileSpan(length: number, scale: number, size: number): number {
  return Math.ceil((Math.ceil(length) * scale) / (size - 2));
}

/**
 * The tallest capture, in CSS pixels, that Chromium draws whole in tiles of either size
 * when it is `width` CSS pixels wide at `scale` device pixels per CSS pixel and starts at
 * the page's top-left corner, where the tiles start.
 */
export function captureHeightLimit(width: number, scale: number): number {
  const limits = TILE_SIZES.map((size) => {
    const budget = (TILE_MEMORY / (size * size * 4)) * (15 / 16);
    return Math.floor((Math.floor(budget / tileSpan(width, scale, size)) * (size - 2)) / scale);
  });
  return Math.min(...limits);
}

/** A capture's size in CSS pixels, and the device pixels per CSS pixel it is drawn at. */
interface Extent {
  width: number;
  height: number;
  scale: number;
}

/** How long a capture is given. */
function captureTimeout({ width, height, scale }: Extent): number {
  return ACTION_TIMEOUT + TILE_TIME_MS * tileSpan(width, scale, 256) * tileSpan(height, scale, 256);
}

/** The terminal window's extent. */
function windowExtent(page: Page): Promise<Extent> {
  return page.evaluate((sel) => {
    const box = (document.querySelector(sel) as HTMLElement).getBoundingClientRect();
    return { width: box.width, height: box.height, scale: devicePixelRatio };
  }, TERMINAL_WINDOW);
}

/** The whole page's extent, measured as Playwright measures it for a full-page capture. */
function pageExtent(page: Page): Promise<Extent> {
  return page.evaluate(() => {
    const els = [document.body, document.documentElement].filter(Boolean);
    return {
      width: Math.max(...els.flatMap((e) => [e.scrollWidth, e.offsetWidth, e.clientWidth])),
      height: Math.max(...els.flatMap((e) => [e.scrollHeight, e.offsetHeight, e.clientHeight])),
      scale: devicePixelRatio,
    };
  });
}

export interface CaptureScreenshotOptions {
  /**
   * A ready page, already authenticated or on the right origin if the demo needs it. Its
   * viewport is set to VIEWPORT, the size the video drivers drive at, so each proof is
   * checked against the layout a video shows.
   */
  page: Page;
  /** Origin a page script's start path is joined onto. A terminal script needs none. */
  baseUrl?: string;
  /** The directory a terminal script's shell starts in (default: the working directory). */
  cwd?: string;
  /** The parsed demo, or a markdown string to parse. */
  demo: Demo | string;
  /** The PNG path. */
  outputPath: string;
  /**
   * Capture the whole scrollable page instead of the viewport. For a terminal script,
   * the whole session instead of the screen: one row for each line the session holds.
   */
  fullPage?: boolean;
  /** Capture one element, the selector's first match, once it is visible. A page script only. */
  selector?: string | null;
  /**
   * Leave out the page's default white background. What the page paints stays opaque, so
   * an element with rounded corners on a page with no background of its own keeps
   * transparent corners. A terminal script's capture always leaves it out.
   */
  transparent?: boolean;
  log?: (m: string) => void;
}

export interface ScreenshotResult {
  outputPath: string;
  /** Steps whose proof failed. The PNG is saved either way, and shows the state they left. */
  failures: number;
}

/** The message for options that ask for the whole page and one element at once. */
export const AREA_CONFLICT = 'screenshot: capture the full page or one element, not both';

/** The message for a selector given with a terminal script, whose page is the engine's. */
export const TERMINAL_SELECTOR = 'screenshot: a terminal script captures its terminal window; --selector picks an element of a page script';

/**
 * Drive `demo` against `page`, checking each step's proof, then save the state the last
 * step leaves as a PNG at `outputPath`. Throws, saving nothing, when the page cannot be
 * driven, the selector never becomes visible, or the PNG cannot be written. An error
 * raised once the steps have run counts the steps whose proof failed.
 */
export async function captureScreenshot(opts: CaptureScreenshotOptions): Promise<ScreenshotResult> {
  if (opts.fullPage && opts.selector) throw new Error(AREA_CONFLICT);
  const log = opts.log ?? ((m: string) => console.log(m));
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  if (demo.terminal && opts.selector) throw new Error(TERMINAL_SELECTOR);
  const { page, baseUrl, selector } = opts;

  await page.setViewportSize(VIEWPORT).catch(() => {});
  const surface = await openSurface(page, demo, { baseUrl, cwd: opts.cwd, backdrop: false, log });
  try {
    let failures = 0;
    for (const step of demo.steps) {
      const { proved } = await runStep(page, baseUrl ?? '', step, demo.steps.length, false, log);
      if (!proved) failures++;
    }
    await surface.settle();

    // A step whose proof failed is the likeliest reason the page lacks what the capture
    // needs, so a capture that fails says how many did. Each one's ✗ line is in the log.
    const failed = failures > 0 ? ` (${failures} step(s) failed their proof)` : '';
    const attempt = async <T>(what: string, act: () => Promise<T>): Promise<T> => {
      try {
        return await act();
      } catch (e) {
        throw new Error(`screenshot: ${what}${failed}: ${(e as Error).message.split('\n')[0]}`);
      }
    };
    // Said after the area of a full-page capture that stops short.
    const limited = (scale: number): string => `, the most one capture holds at scale ${scale}`;

    const shot = { path: opts.outputPath, type: 'png' as const, omitBackground: Boolean(opts.transparent), timeout: ACTION_TIMEOUT };
    if (demo.terminal) {
      let area = 'the terminal window';
      let note = '';
      let timeout = ACTION_TIMEOUT;
      if (opts.fullPage) {
        // A still's window sits at the page's top-left corner, and grows down from there.
        const { width, scale } = await windowExtent(page);
        const held = await attempt('could not grow the window to the session', () => expandToSession(page, captureHeightLimit(width, scale)));
        area = held.rows < held.lines ? `the session's last ${held.rows} of its ${held.lines} lines` : 'the whole terminal session';
        if (held.rows < held.lines) note = limited(scale);
        timeout = captureTimeout(await windowExtent(page));
      }
      log(`screenshot: capturing ${area}${note} → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture ${area}`, () => page.locator(TERMINAL_WINDOW).screenshot({ ...shot, omitBackground: true, timeout }));
    } else if (selector) {
      const el = page.locator(selector).first();
      await attempt(`no visible \`${selector}\` to capture`, () => el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }));
      log(`screenshot: capturing \`${selector}\` → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture \`${selector}\``, () => el.screenshot(shot));
    } else {
      let area = opts.fullPage ? 'the full page' : 'the viewport';
      let note = '';
      let timeout = ACTION_TIMEOUT;
      let clip: { x: number; y: number; width: number; height: number } | undefined;
      if (opts.fullPage) {
        const full = await pageExtent(page);
        const limit = captureHeightLimit(full.width, full.scale);
        if (full.height > limit) {
          clip = { x: 0, y: 0, width: full.width, height: limit };
          area = `the page's top ${limit} of its ${full.height} CSS pixels`;
          note = limited(full.scale);
        }
        timeout = captureTimeout({ ...full, height: Math.min(full.height, limit) });
      }
      log(`screenshot: capturing ${area}${note} → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture ${area}`, () => page.screenshot({ ...shot, timeout, fullPage: Boolean(opts.fullPage), clip }));
    }
    return { outputPath: opts.outputPath, failures };
  } finally {
    await surface.close();
  }
}
