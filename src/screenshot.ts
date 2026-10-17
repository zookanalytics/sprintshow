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

import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, type Demo } from './demo-script.ts';
import { runStep, openSurface, ACTION_TIMEOUT, VIEWPORT } from './browser.ts';
import { expandToSession, TERMINAL_WINDOW } from './terminal.ts';

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
    const attempt = async (what: string, act: () => Promise<unknown>): Promise<void> => {
      try {
        await act();
      } catch (e) {
        throw new Error(`screenshot: ${what}${failed}: ${(e as Error).message.split('\n')[0]}`);
      }
    };

    const shot = { path: opts.outputPath, type: 'png' as const, omitBackground: Boolean(opts.transparent), timeout: ACTION_TIMEOUT };
    if (demo.terminal) {
      const area = opts.fullPage ? 'the whole terminal session' : 'the terminal window';
      if (opts.fullPage) await attempt('could not hold the whole session in the window', () => expandToSession(page));
      log(`screenshot: capturing ${area} → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture ${area}`, () => page.locator(TERMINAL_WINDOW).screenshot({ ...shot, omitBackground: true }));
    } else if (selector) {
      const el = page.locator(selector).first();
      await attempt(`no visible \`${selector}\` to capture`, () => el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }));
      log(`screenshot: capturing \`${selector}\` → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture \`${selector}\``, () => el.screenshot(shot));
    } else {
      const area = opts.fullPage ? 'the full page' : 'the viewport';
      log(`screenshot: capturing ${area} → ${path.basename(opts.outputPath)}`);
      await attempt(`could not capture ${area}`, () => page.screenshot({ ...shot, fullPage: Boolean(opts.fullPage) }));
    }
    return { outputPath: opts.outputPath, failures };
  } finally {
    await surface.close();
  }
}
