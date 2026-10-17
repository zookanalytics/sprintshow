// The one-command orchestrators behind `sprintshow run` and `sprintshow screenshot`:
// bring up the server, drive the demo, tear the server down. The walkthrough driver
// opens its own recorded context. The proof and screenshot drivers take a plain page,
// which this layer launches a browser for. A terminal script takes no server: its steps
// run in the engine's own terminal, whose shell starts in `cwd`.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContextOptions, type Page } from 'playwright';

import { parseDemoScript, outputSlug, type Demo } from './demo-script.ts';
import { ensureServer, type ServeOptions, type ServerHandle } from './server.ts';
import { captureProof, type CaptureResult } from './capture.ts';
import { captureWalkthrough } from './walkthrough.ts';
import { captureScreenshot, AREA_CONFLICT, TERMINAL_SELECTOR, type CaptureScreenshotOptions, type ScreenshotResult } from './screenshot.ts';
import { chromiumLaunchArgs, VIEWPORT } from './browser.ts';
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
  log?: (m: string) => void;
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

export async function runDemo(opts: RunDemoOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { demo, name } = loadDemo(opts.script);
  const mode: CaptureMode = opts.mode ?? 'walkthrough';
  const outputPath = opts.outputPath ?? path.join(process.cwd(), 'demos', `${name}.mp4`);
  log(`demo: "${demo.title}" — ${demo.steps.length} steps · ${mode} mode`);

  const server = await serverFor(demo, opts);
  try {
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
        log,
      });
    }

    return await withHeadlessPage({ viewport: VIEWPORT }, (page) =>
      captureProof({
        page,
        baseUrl: server.baseUrl,
        cwd: opts.cwd,
        demo,
        outputPath,
        noNarrate: opts.noNarrate,
        musicPath: opts.musicPath,
        keep: opts.keep,
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
  /** Device scale factor (default 1): PNG pixels per CSS pixel along each axis. At 2, text stays sharp in a PNG shown at half its size. */
  scale?: number;
}

/**
 * Bring up the server, drive the demo's steps in a fresh headless page at `scale`, save
 * the state the last step leaves as a PNG, and tear the server down. A failed proof
 * still saves the PNG and is counted in `failures`. A terminal script's PNG is its
 * terminal window (see captureScreenshot).
 */
export async function runScreenshot(opts: RunScreenshotOptions): Promise<ScreenshotResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const scale = opts.scale ?? 1;
  // Checked before a server or a browser is spent on a capture that cannot happen.
  if (!(Number.isFinite(scale) && scale > 0)) throw new Error(`screenshot: the scale must be a positive number (got ${opts.scale})`);
  if (opts.fullPage && opts.selector) throw new Error(AREA_CONFLICT);
  const { demo } = loadDemo(opts.script);
  if (demo.terminal && opts.selector) throw new Error(TERMINAL_SELECTOR);
  log(`demo: "${demo.title}" — ${demo.steps.length} steps · screenshot`);

  const server = await serverFor(demo, opts);
  try {
    return await withHeadlessPage({ viewport: VIEWPORT, deviceScaleFactor: scale }, (page) =>
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
