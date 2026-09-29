// The one-command orchestrator behind `sprintshow run`: bring up the server, drive the
// demo in the chosen mode, tear the server down. The two drivers own the browser
// (walkthrough needs a recorded context; proof takes a plain page), so this layer only
// wires the server seam to them.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

import { parseDemoScript, outputSlug, type Demo } from './demo-script.ts';
import { ensureServer, type ServeOptions } from './server.ts';
import { captureProof, type CaptureResult } from './capture.ts';
import { captureWalkthrough } from './walkthrough.ts';
import { chromiumLaunchArgs, VIEWPORT } from './browser.ts';

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

export async function runDemo(opts: RunDemoOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { demo, name } = loadDemo(opts.script);
  const mode: CaptureMode = opts.mode ?? 'walkthrough';
  const outputPath = opts.outputPath ?? path.join(process.cwd(), 'demos', `${name}.mp4`);
  log(`demo: "${demo.title}" — ${demo.steps.length} steps · ${mode} mode`);

  const server = await ensureServer(opts);
  try {
    if (mode === 'walkthrough') {
      return await captureWalkthrough({
        baseUrl: server.baseUrl,
        demo,
        outputPath,
        noNarrate: opts.noNarrate,
        musicPath: opts.musicPath,
        keep: opts.keep,
        headed: opts.headed,
        log,
      });
    }

    const browser = await chromium.launch({ headless: true, args: chromiumLaunchArgs() });
    try {
      const page = await browser.newPage({ viewport: VIEWPORT });
      return await captureProof({
        page,
        baseUrl: server.baseUrl,
        demo,
        outputPath,
        noNarrate: opts.noNarrate,
        musicPath: opts.musicPath,
        keep: opts.keep,
        log,
      });
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await server.stop();
  }
}
