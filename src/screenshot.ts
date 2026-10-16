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

import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, type Demo } from './demo-script.ts';
import { runStep, joinUrl, ACTION_TIMEOUT, VIEWPORT } from './browser.ts';

export interface CaptureScreenshotOptions {
  /**
   * A ready page, already authenticated or on the right origin if the demo needs it. Its
   * viewport is set to VIEWPORT, the size the video drivers drive at, so each proof is
   * checked against the layout a video shows.
   */
  page: Page;
  /** Origin the start path is joined onto. */
  baseUrl: string;
  /** The parsed demo, or a markdown string to parse. */
  demo: Demo | string;
  /** The PNG path. */
  outputPath: string;
  /** Capture the whole scrollable page instead of the viewport. */
  fullPage?: boolean;
  /** Capture one element, the selector's first match, once it is visible. */
  selector?: string | null;
  /**
   * Leave out the page's default white background. What the page paints stays opaque, so
   * an element with rounded corners on a page with no background of its own keeps
   * transparent corners.
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

/**
 * Drive `demo` against `page`, checking each step's proof, then save the state the last
 * step leaves as a PNG at `outputPath`. Throws, saving nothing, when the page cannot be
 * driven or the selector never becomes visible.
 */
export async function captureScreenshot(opts: CaptureScreenshotOptions): Promise<ScreenshotResult> {
  if (opts.fullPage && opts.selector) throw new Error(AREA_CONFLICT);
  const log = opts.log ?? ((m: string) => console.log(m));
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  const { page, baseUrl, selector } = opts;

  await page.setViewportSize(VIEWPORT).catch(() => {});
  await page.goto(joinUrl(baseUrl, demo.start), { waitUntil: 'load' });

  let failures = 0;
  for (const step of demo.steps) {
    const { proved } = await runStep(page, baseUrl, step, demo.steps.length, false, log);
    if (!proved) failures++;
  }

  const shot = { path: opts.outputPath, type: 'png' as const, omitBackground: Boolean(opts.transparent), timeout: ACTION_TIMEOUT };
  if (selector) {
    const el = page.locator(selector).first();
    try {
      await el.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    } catch (e) {
      throw new Error(`screenshot: no visible \`${selector}\` to capture: ${(e as Error).message.split('\n')[0]}`);
    }
    log(`screenshot: capturing \`${selector}\` → ${path.basename(opts.outputPath)}`);
    await el.screenshot(shot);
  } else {
    log(`screenshot: capturing the ${opts.fullPage ? 'full page' : 'viewport'} → ${path.basename(opts.outputPath)}`);
    await page.screenshot({ ...shot, fullPage: Boolean(opts.fullPage) });
  }
  return { outputPath: opts.outputPath, failures };
}
