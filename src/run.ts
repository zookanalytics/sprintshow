// The one-command orchestrators behind `sprintshow run` and `sprintshow screenshot`:
// bring up the server, drive the demo, tear the server down. The walkthrough driver
// opens its own recorded context. The proof and screenshot drivers take a plain page,
// which this layer launches a browser for and makes as the script's device
// (contextOptions). A terminal script takes no server: its steps run in the engine's own
// terminal, whose shell starts in `cwd`.
//
// A run returns a video, screenshots or both, as its caller chooses: the video's driver
// saves each step's screenshot as it drives the steps, and a run with no video drives
// them with the screenshots' own driver (captureScreenshots).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContextOptions, type Page } from 'playwright';

import { parseDemoScript, outputSlug, type Demo } from './demo-script.ts';
import { ensureServer, type ServeOptions, type ServerHandle } from './server.ts';
import { captureProof, type CaptureResult } from './capture.ts';
import { captureWalkthrough } from './walkthrough.ts';
import { captureScreenshot, captureScreenshots, claimScreenshotDir, AREA_CONFLICT, TERMINAL_SELECTOR, type CaptureScreenshotOptions, type ScreenshotResult } from './screenshot.ts';
import { chromiumLaunchArgs, contextOptions } from './browser.ts';
import { shellDir } from './terminal.ts';

export type CaptureMode = 'proof' | 'walkthrough';

export interface RunDemoOptions extends ServeOptions {
  /** Path to a demo-script markdown file, or the parsed/loaded demo. */
  script: string | Demo;
  /** `walkthrough` (default): one continuous recorded take. `proof`: a screenshot per step. */
  mode?: CaptureMode;
  /** Final mp4 path. Defaults to `demos/<script-name>.mp4`. */
  outputPath?: string;
  noNarrate?: boolean;
  musicPath?: string | null;
  keep?: boolean;
  /** Launch the browser headed (walkthrough only). */
  headed?: boolean;
  /**
   * Save a PNG of the state each step leaves into this directory, a new or empty one,
   * named for the step, such as `01-the-board-boots-empty.png`. Each shows the app alone,
   * with no caption, card or pointer on it.
   */
  screenshotDir?: string;
  /** Make no video, so the run returns its screenshots alone. Needs `screenshotDir`, and takes none of the video's options. */
  noVideo?: boolean;
  log?: (m: string) => void;
}

/** What a run returns: its video, unless it made none, and its screenshots, when it took them. */
export interface RunResult extends Omit<CaptureResult, 'outputPath'> {
  /** The MP4, or null for a run that made no video. */
  outputPath: string | null;
}

/** The video's options, each by the flag that sets it, which a run with no video refuses rather than ignores. */
const VIDEO_OPTIONS: [keyof RunDemoOptions, string][] = [
  ['mode', '--mode'],
  ['outputPath', '-o'],
  ['musicPath', '--music'],
  ['noNarrate', '--no-narrate'],
  ['keep', '--keep'],
  ['headed', '--headed'],
];

/** Throw when `opts` asks for no video and gives no screenshot directory, or gives an option only a video takes. */
function checkOutputs(opts: RunDemoOptions): void {
  if (!opts.noVideo) return;
  if (!opts.screenshotDir) throw new Error('run: a run with no video returns its screenshots alone, so it needs a directory for them (--screenshots <dir>)');
  const given = VIDEO_OPTIONS.filter(([key]) => opts[key] !== undefined && opts[key] !== null && opts[key] !== false).map(([, flag]) => flag);
  if (given.length) throw new Error(`run: a run with no video takes none of the video's options; drop ${given.join(', ')}`);
}

function loadDemo(script: string | Demo): { demo: Demo; name: string } {
  if (typeof script !== 'string') return { demo: script, name: outputSlug(slugName(script.title)) };
  const scriptPath = path.resolve(script);
  if (!existsSync(scriptPath)) throw new Error(`demo script not found: ${scriptPath}`);
  const demo = parseDemoScript(readFileSync(scriptPath, 'utf8'));
  return { demo, name: outputSlug(path.basename(scriptPath, path.extname(scriptPath))) };
}

function slugName(title: string): string {
  return title.replace(/[^A-Za-z0-9._-]+/g, '-');
}

/**
 * What a script's steps run against: a page script's server, brought up from the server
 * options, or none for a terminal script, which runs in the engine's own terminal. A
 * server option given with a terminal script is refused rather than ignored, and the
 * directory its shell starts in is checked before a browser is spent.
 */
async function serverFor(demo: Demo, opts: ServeOptions): Promise<ServerHandle> {
  if (!demo.terminal) return ensureServer(opts);
  if (opts.baseUrl || opts.serve || opts.serveDir || opts.port !== undefined) {
    throw new Error("terminal: a terminal script runs in the engine's own terminal and takes no server; drop --base-url, --serve, --serve-dir and --port");
  }
  shellDir(opts.cwd);
  return { baseUrl: '', stop: async () => {} };
}

/** Launch a headless Chromium, hand `use` a new page made with `pageOpts`, and close the browser once `use` settles. */
async function withHeadlessPage<T>(pageOpts: BrowserContextOptions, use: (page: Page) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: true, args: chromiumLaunchArgs() });
  try {
    return await use(await browser.newPage(pageOpts));
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Bring up the server, drive the demo's steps, and tear the server down. The run returns a
 * video in `mode`, a PNG of the state each step leaves in `screenshotDir`, or both. A run
 * with no video drives the steps in a fresh headless page made as the script's device. A
 * failed proof still saves the outputs and is counted in `failures`, and a run that throws
 * saves none of them.
 */
export async function runDemo(opts: RunDemoOptions): Promise<RunResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  checkOutputs(opts);
  const { demo, name } = loadDemo(opts.script);
  const mode: CaptureMode = opts.mode ?? 'walkthrough';
  const outputPath = opts.outputPath ?? path.join(process.cwd(), 'demos', `${name}.mp4`);
  const outputs = opts.noVideo ? 'screenshots alone' : `${mode} mode${opts.screenshotDir ? ' and screenshots' : ''}`;
  log(`demo: "${demo.title}" — ${demo.steps.length} steps · ${outputs}`);
  // Checked before a server or a browser is spent: a device the registry does not hold throws here.
  const device = contextOptions(demo);
  if (opts.screenshotDir) claimScreenshotDir(opts.screenshotDir);

  const server = await serverFor(demo, opts);
  try {
    if (opts.noVideo) {
      const shots = await withHeadlessPage(device, (page) =>
        captureScreenshots({ page, baseUrl: server.baseUrl, cwd: opts.cwd, demo, screenshotDir: opts.screenshotDir as string, log }),
      );
      return { outputPath: null, narrated: false, music: false, failures: shots.failures, capturesDir: null, screenshots: shots.screenshots };
    }

    if (mode === 'walkthrough') {
      return await captureWalkthrough({
        baseUrl: server.baseUrl,
        cwd: opts.cwd,
        demo,
        outputPath,
        noNarrate: opts.noNarrate,
        musicPath: opts.musicPath,
        keep: opts.keep,
        headed: opts.headed,
        screenshotDir: opts.screenshotDir,
        log,
      });
    }

    return await withHeadlessPage(device, (page) =>
      captureProof({
        page,
        baseUrl: server.baseUrl,
        cwd: opts.cwd,
        demo,
        outputPath,
        noNarrate: opts.noNarrate,
        musicPath: opts.musicPath,
        keep: opts.keep,
        screenshotDir: opts.screenshotDir,
        log,
      }),
    );
  } finally {
    await server.stop();
  }
}

export interface RunScreenshotOptions extends ServeOptions, Pick<CaptureScreenshotOptions, 'outputPath' | 'fullPage' | 'selector' | 'transparent' | 'log'> {
  /** Path to a demo-script markdown file, or the parsed demo. */
  script: string | Demo;
  /**
   * Device scale factor: PNG pixels per CSS pixel along each axis. By default, the scale
   * factor of the device the script names, or 1. At 2, text stays sharp in a PNG shown at
   * half its size.
   */
  scale?: number;
}

/**
 * Bring up the server, drive the demo's steps in a fresh headless page made as the
 * script's device at `scale`, save the state the last step leaves as a PNG, and tear the
 * server down. A failed proof still saves the PNG and is counted in `failures`. A
 * terminal script's PNG is its terminal window (see captureScreenshot).
 */
export async function runScreenshot(opts: RunScreenshotOptions): Promise<ScreenshotResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { scale } = opts;
  // Checked before a server or a browser is spent on a capture that cannot happen.
  if (scale !== undefined && !(Number.isFinite(scale) && scale > 0)) throw new Error(`screenshot: the scale must be a positive number (got ${scale})`);
  if (opts.fullPage && opts.selector) throw new Error(AREA_CONFLICT);
  const { demo } = loadDemo(opts.script);
  if (demo.terminal && opts.selector) throw new Error(TERMINAL_SELECTOR);
  const device = contextOptions(demo);
  log(`demo: "${demo.title}" — ${demo.steps.length} steps · screenshot`);

  const server = await serverFor(demo, opts);
  try {
    return await withHeadlessPage({ ...device, deviceScaleFactor: scale ?? device.deviceScaleFactor ?? 1 }, (page) =>
      captureScreenshot({
        page,
        baseUrl: server.baseUrl,
        cwd: opts.cwd,
        demo,
        outputPath: opts.outputPath,
        fullPage: opts.fullPage,
        selector: opts.selector,
        transparent: opts.transparent,
        log,
      }),
    );
  } finally {
    await server.stop();
  }
}
