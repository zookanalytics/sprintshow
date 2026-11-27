// The screenshot drivers: drive a demo script's steps, check each step's proof, and save
// the state the last step leaves as one PNG (captureScreenshot), or the state each step
// leaves as a PNG of its own (captureScreenshots). The steps run through the step runner
// the video drivers use, so a proof means the same thing in a screenshot as in a video.
//
// They draw no caption, pointer, cover or scrutiny card, and they need neither ffmpeg nor
// a narration key. A failed proof does not stop the capture: the PNG is still saved,
// because it shows what failed.
//
// Like the proof driver they take a ready page, so they own neither the browser nor the
// server. The device scale factor belongs to the page's context, as do a device's user
// agent and touch, so the caller sets them where the page is created; `runScreenshot`
// (run.ts) does that for the CLI, from contextOptions (browser.ts).
//
// A terminal script's PNG is the terminal window, not the viewport. The terminal page
// paints nothing around the window, and the default white background is always left
// out, so the window's rounded corners are transparent. With `fullPage`, the window holds
// the whole session instead of the screen. An iOS app script's PNG is the device's own
// screenshot, its whole screen at the device's scale, which the surface takes (ios.ts),
// so no option chooses its area or its scale.
//
// Chromium draws a capture in tiles and holds only so many of them, so every capture goes
// through captureOf, which holds it to what Chromium draws whole (captureHeightLimit) and
// gives it the time its tiles take. A full page and an element keep their top, and a
// terminal session its last lines. A viewport and a terminal window are captured whole or
// not at all, so a scale at which one capture cannot hold the area a screenshot takes by
// default is refused before the steps run. A capture that cannot hold one row of the
// page or the element, or one line of the session, at its scale fails too.
// specs/ss-vyii/capture-limit.md records how the limit was found, and
// specs/ss-emhj/capture-area.md which tiles a capture of part of a page spends.
//
// A run's screenshots are a PNG of the state each step leaves (stepScreenshots), in a
// directory that holds nothing else once the run is done: a new or empty one, into which
// the run writes nothing else, and which a run that ends saving nothing leaves as it found
// it. Each is the area a screenshot takes by default: a page script's viewport, a
// terminal script's window, or an iOS app's screen. A video's driver takes a page's or a
// terminal's in the page it films, where the engine draws its caption, cards, pointer and
// terminal backdrop, so a still is taken with a style that leaves those out. A still
// first waits for the animations running in the page to end, the engine's, such as a
// click's ripple, as well as the app's, so it shows the state they settle in. A
// walkthrough cuts the stretch in which a still is taken from its video (walkthrough.ts).

import { existsSync, mkdirSync, readdirSync, readlinkSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page, PageScreenshotOptions } from 'playwright';

import { parseDemoScript, slugify, surfaceOf, type Demo, type DemoStep, type ViewportSize } from './demo-script.ts';
import { runStep, openSurface, contextOptions, lastViewport, ACTION_TIMEOUT, POINTER_CHROME, type Surface } from './browser.ts';
import { expandToSession, TERMINAL_WINDOW, TERMINAL_STILL_CSS } from './terminal.ts';
import { OVERLAY_CHROME } from './overlay.ts';

/**
 * Chromium rasterizes a capture in square tiles, each laid two device pixels short of its
 * size so that it overlaps the next, and holds at most 512 MiB of them, at 4 bytes a
 * pixel. That is its least on a desktop host, and a larger screen raises it. A tile is
 * 256 pixels on a side, so 2048 of them fit. On macOS and ChromeOS, a browser started on
 * a screen at scale 2 or more draws in tiles of 512 pixels, and only 512 of them fit. A
 * page cannot tell which size its browser draws in, so a capture is held to what both
 * draw. A capture spends tiles only on the area it captures, which are laid from the
 * page's top-left corner wherever the area starts. A capture that spans more comes out
 * with the tiles past the budget unpainted, transparent in a terminal still and the
 * page's background in a page capture. A capture that stops above the end of the page is
 * sometimes drawn up to 24 tiles short of the budget, so a capture spends at most 15/16
 * of it.
 */
const TILE_SIZES = [256, 512];
const TILE_MEMORY = 512 * 1024 * 1024;
/** The time a capture is given for each 256-pixel tile it spans, on top of ACTION_TIMEOUT: rasterizing and encoding it take time in proportion to its area. */
const TILE_TIME_MS = 100;

/** The tiles of `size` device pixels that a capture spans from `start` to `end` CSS pixels along one side of the page, at `scale` device pixels per CSS pixel. */
function tileSpan(start: number, end: number, scale: number, size: number): number {
  const step = size - 2;
  return Math.ceil((Math.ceil(end) * scale) / step) - Math.floor((Math.floor(start) * scale) / step);
}

/**
 * The tallest capture, in CSS pixels, that Chromium draws whole in tiles of either size
 * when it is `width` CSS pixels wide at `scale` device pixels per CSS pixel and its
 * top-left corner lies `at` on the page, by default the page's own, where the tiles start.
 * It is 0 when one row of tiles across that width is more than the budget.
 */
export function captureHeightLimit(width: number, scale: number, at = { x: 0, y: 0 }): number {
  const limits = TILE_SIZES.map((size) => {
    const step = size - 2;
    const budget = (TILE_MEMORY / (size * size * 4)) * (15 / 16);
    const rows = Math.floor(budget / tileSpan(at.x, at.x + width, scale, size));
    // The capture's rows of tiles start at the one its top lies in.
    const top = Math.floor(at.y);
    return Math.max(0, Math.floor(((Math.floor((top * scale) / step) + rows) * step) / scale) - top);
  });
  return Math.min(...limits);
}

/** A capture's place on the page and its size, in CSS pixels, and the device pixels per CSS pixel it is drawn at. */
interface Extent {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/** How long a capture is given. */
function captureTimeout({ x, y, width, height, scale }: Extent): number {
  return ACTION_TIMEOUT + TILE_TIME_MS * tileSpan(x, x + width, scale, 256) * tileSpan(y, y + height, scale, 256);
}

/** The terminal window's extent. Throws when the page has no terminal window. */
async function windowExtent(page: Page): Promise<Extent> {
  const extent = await page.evaluate((sel) => {
    const box = document.querySelector(sel)?.getBoundingClientRect();
    return box && { x: box.left + scrollX, y: box.top + scrollY, width: box.width, height: box.height, scale: devicePixelRatio };
  }, TERMINAL_WINDOW);
  if (!extent) throw new Error('this page has no terminal window');
  return extent;
}

/** The whole page's extent, measured as Playwright measures it for a full-page capture. */
function pageExtent(page: Page): Promise<Extent> {
  return page.evaluate(() => {
    const els = [document.body, document.documentElement].filter(Boolean);
    return {
      x: 0,
      y: 0,
      width: Math.max(...els.flatMap((e) => [e.scrollWidth, e.offsetWidth, e.clientWidth])),
      height: Math.max(...els.flatMap((e) => [e.scrollHeight, e.offsetHeight, e.clientHeight])),
      scale: devicePixelRatio,
    };
  });
}

/** What one capture takes: the page's viewport, the whole page, or the first element a locator matches. */
export type CaptureArea = 'viewport' | 'page' | Locator;

/** The options a capture is saved with, besides the time it is given and the part of its area it holds. */
export type CaptureShot = Pick<PageScreenshotOptions, 'path' | 'type' | 'omitBackground' | 'style'>;

/** One capture of an area, as the area lies on the page when it was measured. */
export interface Capture {
  /** The area: its place on the page, its size and its scale. */
  readonly extent: Extent;
  /**
   * The CSS pixels of the area's height, from its top, that the capture holds: all of them,
   * as many as one capture holds, or, for an element that reaches past the page's end, as
   * many as lie above it.
   */
  readonly height: number;
  /** The page ends above the most of the area one capture holds, so the capture holds what lies above the end. */
  readonly pageEnds: boolean;
  /** Save the capture as a PNG, given the time the tiles it spans take. */
  save(shot: CaptureShot): Promise<void>;
}

/** Where `area` lies on the page now, its size, and the device pixels per CSS pixel it is drawn at. */
async function areaExtent(page: Page, area: CaptureArea): Promise<Extent> {
  if (area === 'page') return pageExtent(page);
  if (area === 'viewport') {
    return page.evaluate(() => ({ x: visualViewport?.pageLeft ?? scrollX, y: visualViewport?.pageTop ?? scrollY, width: innerWidth, height: innerHeight, scale: devicePixelRatio }));
  }
  // An element's box is measured from the viewport, and the page's tiles from the page's corner.
  const box = await area.boundingBox({ timeout: ACTION_TIMEOUT });
  if (!box) throw new Error('the element has no box');
  const at = await page.evaluate(() => ({ x: scrollX, y: scrollY, scale: devicePixelRatio }));
  return { x: box.x + at.x, y: box.y + at.y, width: box.width, height: box.height, scale: at.scale };
}

/** Why one capture at `extent`'s scale holds none of `what`: all of it, for an area captured whole, or one row of it. */
function tooLarge(what: string, { width, height, scale }: Extent, whole: boolean): string {
  const size = whole ? `of ${Math.round(width)}x${Math.round(height)} CSS pixels` : `${Math.round(width)} CSS pixels wide`;
  return `scale ${scale} is too large for one capture of ${what} ${size}`;
}

/** `box` in the whole pixels it touches, as Playwright captures an element. */
function inPixels(box: Extent): Extent {
  const x = Math.floor(box.x);
  const y = Math.floor(box.y);
  return { x, y, width: Math.ceil(box.x + box.width) - x, height: Math.ceil(box.y + box.height) - y, scale: box.scale };
}

/**
 * The capture of `area` as it lies on `page` now, in the whole pixels it touches, as
 * Playwright captures an element. It holds the whole area, or, given `keepTop`, as much of
 * its top as Chromium draws whole (captureHeightLimit). Throws, saying the scale is too
 * large for one capture of `what`, such as "a viewport", when one capture cannot hold the
 * whole area, or, given `keepTop`, one row of it.
 *
 * The top of an element taller than one capture holds is scrolled to the top of each box it
 * scrolls in, so that each shows it, and measured there. A capture of the page reaches no
 * further than the page's end, so that capture stops there at the latest.
 */
export async function captureOf(page: Page, area: CaptureArea, what: string, { keepTop = false } = {}): Promise<Capture> {
  let extent = inPixels(await areaExtent(page, area));
  let height = Math.min(extent.height, captureHeightLimit(extent.width, extent.scale, extent));
  if (height < (keepTop ? 1 : extent.height)) throw new Error(tooLarge(what, extent, !keepTop));
  let pageEnds = false;
  if (typeof area === 'object' && height < extent.height) {
    await area.evaluate((el) => el.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' }));
    extent = inPixels(await areaExtent(page, area));
    const most = Math.min(extent.height, captureHeightLimit(extent.width, extent.scale, extent));
    const above = (await pageExtent(page)).height - extent.y;
    pageEnds = above < most;
    height = Math.min(most, above);
  }
  const { x, y, width } = extent;
  return {
    extent,
    height,
    pageEnds,
    async save(shot) {
      const timeout = captureTimeout({ ...extent, height });
      if (area === 'viewport') await page.screenshot({ ...shot, timeout });
      else if (area === 'page') await page.screenshot({ ...shot, timeout, fullPage: true, clip: height < extent.height ? { x: 0, y: 0, width, height } : undefined });
      // An element held whole is captured as Playwright captures one, once it scrolls it
      // into view. The top of a taller one is a clip of the page over that part of its box,
      // as Playwright captures an element larger than the viewport as a clip of its box.
      else if (height === extent.height) await area.screenshot({ ...shot, timeout });
      else await page.screenshot({ ...shot, timeout, fullPage: true, clip: { x, y, width, height } });
    },
  };
}

/**
 * Throw when one capture at `scale` cannot hold the whole of a viewport of `size` at the
 * page's top-left corner, the area a page script's screenshot takes by default.
 */
export function checkViewportScale(size: ViewportSize, scale: number): void {
  if (captureHeightLimit(size.width, scale) < size.height) throw new Error(`screenshot: ${tooLarge('a viewport', { x: 0, y: 0, ...size, scale }, true)}`);
}

export interface CaptureScreenshotOptions {
  /**
   * A ready page, already authenticated or on the right origin if the demo needs it. Its
   * viewport is set to the one the script starts at, as the video drivers' is, so each
   * proof is checked against the layout a video shows.
   */
  page: Page;
  /** Origin a page script's start path is joined onto, or an iOS app script's simulator URL. A terminal script needs none. */
  baseUrl?: string;
  /** The directory a terminal script's shell starts in (default: the working directory). */
  cwd?: string;
  /**
   * For an iOS app script, the loopback ports of the servers the driver starts to drive the
   * app, Appium's, WebDriverAgent's and its stream of the screen's frames, one for each in
   * that order (iosPorts). Each listens on a free port the system assigns unless this
   * names them. A page or terminal script's driver starts no server, and reads none.
   */
  port?: number | readonly number[];
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

/** The message for an option that chooses a capture's area, scale or background, given with an iOS app script. */
export const IOS_AREA = "screenshot: an iOS app script captures the device's whole screen at the device's scale; --full-page, --selector, --scale and --transparent are for a page or terminal script";

/**
 * Drive `demo` against `page`, checking each step's proof, then save the state the last
 * step leaves as a PNG at `outputPath`. Throws, saving nothing, when the script names a
 * device Playwright does not describe, the page cannot be driven, the selector never
 * becomes visible, one capture at the page's scale cannot hold the whole viewport or
 * terminal window it takes, or one row of the page or element, or one line of the
 * session, or the PNG cannot be written. A viewport or window it takes by default is
 * refused before the first step. An error raised once the steps have run counts the
 * steps whose proof failed.
 */
export async function captureScreenshot(opts: CaptureScreenshotOptions): Promise<ScreenshotResult> {
  if (opts.fullPage && opts.selector) throw new Error(AREA_CONFLICT);
  const log = opts.log ?? ((m: string) => console.log(m));
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  if (demo.terminal && opts.selector) throw new Error(TERMINAL_SELECTOR);
  if (surfaceOf(demo) === 'ios' && (opts.fullPage || opts.selector || opts.transparent)) throw new Error(IOS_AREA);
  const start = contextOptions(demo).viewport as ViewportSize;
  const { page } = opts;
  // The area a screenshot takes by default is known before the steps run: a page script's
  // viewport, at the size the last step leaves it, and a terminal's window, which the
  // steps leave as it is once the terminal is laid out.
  const byDefault = !opts.fullPage && !opts.selector;
  if (byDefault && surfaceOf(demo) === 'page') checkViewportScale(lastViewport(demo), await page.evaluate(() => devicePixelRatio));
  const ready =
    byDefault && demo.terminal
      ? async (): Promise<void> => {
          await captureOf(page, page.locator(TERMINAL_WINDOW), 'a window').catch((e: Error) => Promise.reject(new Error(`screenshot: ${e.message}`)));
        }
      : undefined;
  return driveSteps({ page, baseUrl: opts.baseUrl, cwd: opts.cwd, port: opts.port, demo, log, ready }, start, null, (failures, surface) => saveArea(opts, demo, surface, failures, log));
}

/** Save the area `opts` asks for as the PNG at its `outputPath`, once `demo`'s steps have run on `surface`, `failures` of them failing their proof. */
async function saveArea(opts: CaptureScreenshotOptions, demo: Demo, surface: Surface, failures: number, log: (m: string) => void): Promise<ScreenshotResult> {
  const { page, selector } = opts;
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
  const file = path.basename(opts.outputPath);
  // Said after the area of a capture that holds only part of it.
  const limited = (scale: number): string => `, the most one capture holds at scale ${scale}`;
  // The area a capture holds, and what is said after it: `whole` when it holds all of it, else the top it keeps of what `whose` names.
  const areaHeld = (capture: Capture, whole: string, whose: string): [string, string] =>
    capture.height < capture.extent.height
      ? [`${whose} top ${capture.height} of its ${capture.extent.height} CSS pixels`, capture.pageEnds ? ', where the page ends' : limited(capture.extent.scale)]
      : [whole, ''];

  const shot = { path: opts.outputPath, type: 'png' as const, omitBackground: Boolean(opts.transparent) };
  if (surface.still) {
    log(`screenshot: capturing the device's screen → ${file}`);
    await attempt("could not capture the device's screen", () => (surface.still as (file: string) => Promise<void>)(opts.outputPath));
  } else if (demo.terminal) {
    let area = 'the terminal window';
    let note = '';
    if (opts.fullPage) {
      // A still's window sits at the page's top-left corner, and grows down from there. A
      // full-screen program's screen is not grown, so its window is captured as it is.
      const win = await attempt('could not measure the terminal window', () => windowExtent(page));
      const held = await attempt('could not grow the window to the session', () => expandToSession(page, captureHeightLimit(win.width, win.scale, win)));
      if (held.rows < 1) throw new Error(`screenshot: could not capture the terminal session${failed}: ${tooLarge('a window', win, false)}`);
      area = held.rows < held.lines ? `the session's last ${held.rows} of its ${held.lines} lines` : 'the whole terminal session';
      if (held.rows < held.lines) note = limited(win.scale);
    }
    const capture = await attempt(`could not capture ${area}`, () => captureOf(page, page.locator(TERMINAL_WINDOW), 'a window'));
    log(`screenshot: capturing ${area}${note} → ${file}`);
    await attempt(`could not capture ${area}`, () => capture.save({ ...shot, omitBackground: true }));
  } else if (selector) {
    const el = page.locator(selector).first();
    await attempt(`no visible \`${selector}\` to capture`, () => el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }));
    const capture = await attempt(`could not capture \`${selector}\``, () => captureOf(page, el, 'an element', { keepTop: true }));
    const [area, note] = areaHeld(capture, `\`${selector}\``, `\`${selector}\`'s`);
    log(`screenshot: capturing ${area}${note} → ${file}`);
    await attempt(`could not capture ${area}`, () => capture.save(shot));
  } else {
    const whole = opts.fullPage ? 'the full page' : 'the viewport';
    const capture = await attempt(`could not capture ${whole}`, () => (opts.fullPage ? captureOf(page, 'page', 'a page', { keepTop: true }) : captureOf(page, 'viewport', 'a viewport')));
    const [area, note] = areaHeld(capture, whole, "the page's");
    log(`screenshot: capturing ${area}${note} → ${file}`);
    await attempt(`could not capture ${area}`, () => capture.save(shot));
  }
  return { outputPath: opts.outputPath, failures };
}

/** What a screenshot driver drives its steps with. */
interface DriveOptions {
  page: Page;
  baseUrl?: string;
  cwd?: string;
  port?: number | readonly number[];
  demo: Demo;
  log: (m: string) => void;
  /** Called once the surface is open, before the first step runs. */
  ready?: () => Promise<void>;
}

/**
 * Drive `demo`'s steps in `page` for a screenshot, at the viewport `start` the script
 * starts at and on a surface the engine draws nothing on, checking each step's proof.
 * Given `each`, it hands it each step and the surface once the step's proof is checked
 * and the surface shows everything it was sent. Once every step has run and the surface
 * has settled, it resolves with what `end` makes of the number of steps whose proof
 * failed, and then closes the surface.
 */
async function driveSteps<T>(opts: DriveOptions, start: ViewportSize, each: ((step: DemoStep, surface: Surface) => Promise<unknown>) | null, end: (failures: number, surface: Surface) => Promise<T>): Promise<T> {
  const { page, demo, baseUrl, log } = opts;
  await page.setViewportSize(start).catch(() => {});
  const surface = await openSurface(page, demo, { baseUrl, cwd: opts.cwd, port: opts.port, backdrop: false, log });
  try {
    await opts.ready?.();
    let failures = 0;
    for (const step of demo.steps) {
      const { proved } = await runStep(page, baseUrl ?? '', step, demo.steps.length, false, log);
      if (!proved) failures++;
      if (each) {
        await surface.settle();
        await each(step, surface);
      }
    }
    await surface.settle();
    return await end(failures, surface);
  } finally {
    await surface.close();
  }
}

/** The elements the engine draws in the page a video is filmed in, which a still leaves out. */
const CHROME = `${OVERLAY_CHROME},${POINTER_CHROME}`;

/**
 * The style a still is taken with. It hides the engine's chrome, and lays a terminal's
 * backdrop page out as a still's.
 *
 * The chrome is made transparent. Opacity hides an element with everything it holds,
 * pseudo-elements included, so no style the page gives what it holds shows any of it, as
 * `span { visibility: visible }` would show the spans of an element hidden by its
 * visibility. The chrome's transitions are off, so neither its own, such as a card's
 * fade, nor one a page's rule forces on it, such as
 * `* { transition: all 1s !important }`, eases it out over the capture.
 *
 * The chrome stays laid out. Taken out of the layout with `display: none`, it would be
 * laid out anew once the still is done, and the browser would report the caption's text
 * as shown again. A page keeps only its first 150 such reports for an observer that
 * starts later, and the caption's and the frame marker's times are read from them
 * (overlay.ts).
 */
const STILL_STYLE = `${CHROME}{opacity:0!important;transition:none!important}${TERMINAL_STILL_CSS}`;

/** The longest a still waits for the animations running in its page to end. */
const ANIMATION_WAIT_MS = 1000;

/** The longest a step's caption runs in its screenshot's name. */
const STEP_NAME_CHARS = 48;

/**
 * The name of a PNG of the state `step` leaves, in a script of `total` steps, both a run's
 * screenshot and a proof video's frame: its number, padded so the names sort in step
 * order, and its caption as a slug, cut at a word to at most 48 characters, such as
 * `01-the-board-boots-empty.png`.
 */
export function stepFileName(step: DemoStep, total: number): string {
  const number = String(step.index).padStart(Math.max(2, String(total).length), '0');
  let slug = slugify(step.narration);
  if (slug.length > STEP_NAME_CHARS) {
    // Cut at the last dash that leaves a whole word, or mid-word when the first word is longer than the name may run.
    const word = slug.lastIndexOf('-', STEP_NAME_CHARS);
    slug = slug.slice(0, word > 0 ? word : STEP_NAME_CHARS);
  }
  return `${number}-${slug || 'step'}.png`;
}

/**
 * The most links a path is followed through, so that a loop of links ends. It is no fewer
 * than the links a system follows in one path before it refuses the path as a loop, 32 on
 * macOS and 40 on Linux, so a path the run can write through is followed to its end.
 */
const MAX_LINKS = 40;

/** Where the link `file` leads, as it is written in the link, or null when `file` is no link. */
function linkTarget(file: string): string | null {
  try {
    return readlinkSync(file);
  } catch {
    return null;
  }
}

/**
 * The place `file` names, as an absolute path through no link, so that two paths to one
 * place come out alike. The part of `file` that exists is as the system resolves it
 * (realpath): each link on it followed, and on macOS each name as the disk spells it. A
 * link just past that part leads to nothing yet, and is followed too, because the run can
 * make what it leads to, such as its screenshot directory, before it writes through the
 * link. The names below that do not exist yet, and are kept as they are.
 */
function placeOf(file: string, links = 0): string {
  const missing: string[] = [];
  for (let at = path.resolve(file); ; at = path.dirname(at)) {
    let real: string;
    try {
      real = realpathSync.native(at);
    } catch {
      if (at === path.dirname(at)) return path.resolve(file);
      missing.unshift(path.basename(at));
      continue;
    }
    const target = missing.length > 0 && links < MAX_LINKS ? linkTarget(path.join(real, missing[0])) : null;
    return target === null ? path.join(real, ...missing) : placeOf(path.resolve(real, target, ...missing.slice(1)), links + 1);
  }
}

/** Whether the place `file` names is the place `dir` names, or lies inside it (placeOf). */
function within(dir: string, file: string): boolean {
  const rel = path.relative(placeOf(dir), placeOf(file));
  return rel === '' || (rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel));
}

/**
 * Throw unless `dir` can hold a run's screenshots and nothing else: it is a new directory
 * or an empty one, and none of `writes`, the paths the run writes besides its screenshots,
 * such as its video and its working directory, lies inside it. Makes nothing.
 */
export function checkScreenshotDir(dir: string, writes: string[] = []): void {
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) throw new Error(`screenshots: ${dir} is a file; name a new or empty directory`);
    if (readdirSync(dir).length > 0) throw new Error(`screenshots: ${dir} already holds files; name a new or empty directory`);
  }
  const held = writes.find((file) => within(dir, file));
  if (held) throw new Error(`screenshots: ${dir} would also hold ${held}, which the run writes too; name a directory the run writes nothing else into`);
}

/**
 * Save what `page` shows now as the PNG `file`, the area a screenshot of `demo` takes by
 * default: a page script's viewport, or a terminal script's window with its corners
 * transparent. Nothing the engine draws in the page shows in it. It waits first for the
 * animations running in the page to end, for up to ANIMATION_WAIT_MS: the app's, and the
 * engine's too, which the still leaves out but a video can show on either side of it.
 * Given `quietMs`, it then waits for the browser to draw the state they end in, and for
 * `quietMs` more. Resolves with the wall-clock time in ms at which it began the capture:
 * until then, the page shows nothing the capture changes. Throws when one capture cannot
 * hold the whole viewport or window (captureOf). A surface that takes its own stills, an
 * iOS app, saves the still itself, and the page is left as it is.
 */
async function saveStill(page: Page, surface: Surface, demo: Demo, file: string, quietMs = 0): Promise<number> {
  if (surface.still) {
    const began = Date.now();
    await surface.still(file);
    return began;
  }
  await page
    .evaluate(
      async ({ ms, drawn }) => {
        const ending = document.getAnimations().filter((a) => a.playState === 'running' && Number.isFinite(Number(a.effect?.getComputedTiming().endTime)));
        await Promise.race([Promise.allSettled(ending.map((a) => a.finished)), new Promise((resolve) => setTimeout(resolve, ms))]);
        // The second animation frame begins once the browser has drawn the first.
        if (drawn) await Promise.race([new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))), new Promise((resolve) => setTimeout(resolve, ms))]);
      },
      { ms: ANIMATION_WAIT_MS, drawn: quietMs > 0 },
    )
    .catch(() => {});
  if (quietMs > 0) await page.waitForTimeout(quietMs);
  const capture = demo.terminal ? await captureOf(page, page.locator(TERMINAL_WINDOW), 'a window') : await captureOf(page, 'viewport', 'a viewport');
  const began = Date.now();
  await capture.save({ path: file, type: 'png', style: STILL_STYLE, omitBackground: Boolean(demo.terminal) });
  return began;
}

/** What saves a capture's screenshots, and the ones it has saved. */
export interface StepScreenshots {
  /**
   * Save what `surface` shows now in `page` as the screenshot of `step`, once the
   * animations running in the page have ended and, given `quietMs`, once the browser has
   * drawn their end and `quietMs` more has passed. Resolves with the wall-clock time in ms
   * at which it began the capture: until then, the page shows nothing the capture changes.
   * A surface that takes its own stills saves it, and changes nothing in the page.
   */
  take(page: Page, surface: Surface, step: DemoStep, quietMs?: number): Promise<number>;
  /** The screenshots saved, in step order. */
  readonly saved: string[];
  /** Remove every screenshot saved, and the directory for them if the claim made it, for a capture that ends saving nothing. */
  discard(): void;
}

/**
 * Claim `dir` for the screenshots of a capture of `demo`, which writes `writes` besides
 * them (checkScreenshotDir), and return what saves them: a PNG of the state each step
 * leaves, named for the step (stepFileName), with nothing the engine draws on it.
 */
export function stepScreenshots(demo: Demo, dir: string, log: (m: string) => void, writes: string[] = []): StepScreenshots {
  checkScreenshotDir(dir, writes);
  // The directories the claim makes, the screenshots' own first, which discard removes.
  const made: string[] = [];
  const first = mkdirSync(dir, { recursive: true });
  if (first !== undefined) {
    for (let d = path.resolve(dir); ; d = path.dirname(d)) {
      made.push(d);
      if (d === path.resolve(first) || d === path.dirname(d)) break;
    }
  }
  const saved: string[] = [];
  return {
    saved,
    async take(page, surface, step, quietMs) {
      const file = path.join(dir, stepFileName(step, demo.steps.length));
      let began: number;
      try {
        began = await saveStill(page, surface, demo, file, quietMs);
      } catch (e) {
        throw new Error(`screenshot: could not capture step ${step.index}: ${(e as Error).message.split('\n')[0]}`);
      }
      saved.push(file);
      log(`  · screenshot → ${path.basename(file)}`);
      return began;
    },
    discard() {
      for (const file of saved.splice(0)) rmSync(file, { force: true });
      // A directory the claim made goes too, unless something else has been put in it since.
      for (const d of made.splice(0)) {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
      }
    },
  };
}

export interface CaptureScreenshotsOptions {
  /** A ready page, as captureScreenshot takes one. Its viewport is set to the one the script starts at. */
  page: Page;
  /** Origin a page script's start path is joined onto, or an iOS app script's simulator URL. A terminal script needs none. */
  baseUrl?: string;
  /** The directory a terminal script's shell starts in (default: the working directory). */
  cwd?: string;
  /**
   * For an iOS app script, the loopback ports of the servers the driver starts to drive the
   * app, Appium's, WebDriverAgent's and its stream of the screen's frames, one for each in
   * that order (iosPorts). Each listens on a free port the system assigns unless this
   * names them. A page or terminal script's driver starts no server, and reads none.
   */
  port?: number | readonly number[];
  /** The parsed demo, or a markdown string to parse. */
  demo: Demo | string;
  /** The directory each step's screenshot goes into: a new or empty one. */
  screenshotDir: string;
  log?: (m: string) => void;
}

export interface ScreenshotsResult {
  /** Each step's screenshot, in step order. */
  screenshots: string[];
  /** Steps whose proof failed. Their screenshots are saved either way, and show the state they left. */
  failures: number;
}

/**
 * Drive `demo` against `page`, checking each step's proof, and save a PNG of the state
 * each step leaves into `screenshotDir`, with no video. Throws, keeping no screenshot,
 * when the script names a device Playwright does not describe, the directory is a file or
 * holds files, the page cannot be driven, or a screenshot cannot be taken or written.
 */
export async function captureScreenshots(opts: CaptureScreenshotsOptions): Promise<ScreenshotsResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  // Read before anything is written: a device the registry does not hold throws here.
  const start = contextOptions(demo).viewport as ViewportSize;
  const shots = stepScreenshots(demo, opts.screenshotDir, log);
  const { page } = opts;
  try {
    return await driveSteps({ page, baseUrl: opts.baseUrl, cwd: opts.cwd, port: opts.port, demo, log }, start, (step, surface) => shots.take(page, surface, step), async (failures) => ({ screenshots: [...shots.saved], failures }));
  } catch (e) {
    shots.discard();
    throw e;
  }
}
