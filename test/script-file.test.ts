// Tests for how a driver and a run take a demo script (loadDemo in src/script-file.ts):
// the path of the script's file, or the parsed demo.
//
// Each driver, runDemo and runScreenshot read a string as the path of a script's file,
// resolved against the working directory, and name the file they cannot find instead of
// reading the string as the script's markdown. The proof driver handed a ready page and
// the path of a script relative to the working directory, as the README's library section
// shows, makes the video.
//
// The tests need a headless Chromium, and the walkthrough and the video a real ffmpeg, and
// they skip without them (see browser-fixture.ts and assemble.test.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { captureProof } from '../src/capture.ts';
import { captureWalkthrough } from '../src/walkthrough.ts';
import { captureScreenshot, captureScreenshots } from '../src/screenshot.ts';
import { runDemo, runScreenshot } from '../src/run.ts';
import { ffmpegBin } from '../src/ffmpeg.ts';
import { launchBrowser, scratchDir, serveSite, writeFiles } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";
const quiet = (): void => {};

/** Each call that takes a demo script, handed `script` with its outputs in `dir`, and why it skips on this host, if it does. */
const CALLS: { name: string; needs: string | false; call: (page: Page, script: string, dir: string) => Promise<unknown> }[] = [
  { name: 'captureProof', needs: skip, call: (page, demo, dir) => captureProof({ page, demo, outputPath: path.join(dir, 'out.mp4'), log: quiet }) },
  { name: 'captureWalkthrough', needs: skip || needsFfmpeg, call: (_page, demo, dir) => captureWalkthrough({ browser: browser!, demo, outputPath: path.join(dir, 'out.mp4'), log: quiet }) },
  { name: 'captureScreenshot', needs: skip, call: (page, demo, dir) => captureScreenshot({ page, demo, outputPath: path.join(dir, 'out.png'), log: quiet }) },
  { name: 'captureScreenshots', needs: skip, call: (page, demo, dir) => captureScreenshots({ page, demo, screenshotDir: path.join(dir, 'shots'), log: quiet }) },
  { name: 'runDemo', needs: skip, call: (_page, script, dir) => runDemo({ script, outputPath: path.join(dir, 'out.mp4'), log: quiet }) },
  { name: 'runScreenshot', needs: skip, call: (_page, script, dir) => runScreenshot({ script, outputPath: path.join(dir, 'out.png'), log: quiet }) },
];

for (const { name, needs, call } of CALLS) {
  test(`${name} reads a string as the path of a script's file, and names the file it cannot find`, { skip: needs }, async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      const missing = path.join(dir, 'missing.md');
      await assert.rejects(call(page, missing, dir), { message: `demo script not found: ${missing}` });
    } finally {
      await page.close();
      cleanup();
    }
  });
}

const SCRIPT = `# Demo: A script read from its file

**Start:** \`/\`

## Steps

1. **The page says hello**
   _Prove:_ the greeting shows — \`visible #hello\`
`;

test('the proof driver handed a ready page and the path of a script relative to the working directory, as the README shows, makes the video', { skip: skip || needsFfmpeg, timeout: 120_000 }, async () => {
  const site = await serveSite({ 'index.html': '<!doctype html><h1 id="hello">Hello</h1>' });
  const { dir, cleanup } = scratchDir();
  const page = await browser!.newPage();
  try {
    writeFiles(dir, { 'demo.md': SCRIPT });
    const outputPath = path.join(dir, 'out.mp4');
    const demo = path.relative(process.cwd(), path.join(dir, 'demo.md'));
    const result = await captureProof({ page, baseUrl: site.baseUrl, demo, outputPath, noNarrate: true, captureRoot: dir, log: quiet });
    assert.equal(result.failures, 0, "the script's proof held");
    assert.ok(existsSync(outputPath), 'the video was made');
  } finally {
    await page.close();
    await site.close();
    cleanup();
  }
});
