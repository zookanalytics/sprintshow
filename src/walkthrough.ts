// The walkthrough ("recordVideo") driver: one continuous take of the demo, driven at a
// human pace with the synthetic pointer and live on-screen captions, recorded by
// Playwright and finished into an MP4. This is the library / marketing path — smoother
// and more watchable than the still-frame proof path, at the cost of frame-exact proof
// screenshots.
//
// It still checks each step's `_Prove:_` / `_Fail if:_` assertion, so a failed proof
// shows on screen (a red caption badge) and in the result, rather than being papered
// over by a nice-looking video.

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

import { parseDemoScript, outputSlug, type Demo, type DemoStep } from './demo-script.ts';
import { requireFfmpeg, run, buildNarration, mixMusicBed, muxOrCopy } from './ffmpeg.ts';
import {
  installPointer,
  runAction,
  awaitAssertion,
  checkAssertion,
  joinUrl,
  chromiumLaunchArgs,
  VIEWPORT,
  PROVE_TIMEOUT,
} from './browser.ts';
import { showCaption, coverInnerHtml, scrutinyInnerHtml, showCardOverlay } from './overlay.ts';
import type { CaptureResult } from './capture.ts';

const BRAND = 'sprintshow · walkthrough';
const COVER_MS = 3800;
const FAIL_HOLD_MS = 1400; // let a failed step's red badge read before moving on
const TAIL_MS = 1600; // a beat at the end when there is no scrutiny card

export interface CaptureWalkthroughOptions {
  /** Reuse a browser (left open). Omit to launch and close one. */
  browser?: Browser;
  /** Origin the start path is joined onto. */
  baseUrl: string;
  demo: Demo | string;
  outputPath: string;
  noNarrate?: boolean;
  musicPath?: string | null;
  /** Keep the `.captures/<run>/` working dir (the raw .webm + manifest). */
  keep?: boolean;
  captureRoot?: string;
  /** Launch headed (ignored when `browser` is supplied). */
  headed?: boolean;
  log?: (m: string) => void;
}

interface SegMark {
  narration: string;
  at: number;
}

async function walkStep(page: import('playwright').Page, base: string, step: DemoStep, total: number, log: (m: string) => void): Promise<boolean> {
  log(`step ${step.index}/${total}: ${step.narration}`);
  await showCaption(page, step.index, total, step.narration, false);
  for (const act of step.actions) await runAction(page, base, act, true, log);

  let proved = true;
  let reason = '';
  if (step.prove?.assertion) {
    proved = await awaitAssertion(page, step.prove.assertion, PROVE_TIMEOUT);
    if (!proved) reason = `_Prove:_ did not hold: \`${step.prove.assertion.raw}\``;
  }
  if (proved && step.failIf?.assertion) {
    if (await checkAssertion(page, step.failIf.assertion)) {
      proved = false;
      reason = `_Fail if:_ condition matched: \`${step.failIf.assertion.raw}\``;
    }
  }
  const manual = !step.prove?.assertion && !step.failIf?.assertion;
  log(proved ? (manual ? '  ✓ (manual — no machine assertion)' : '  ✓ proof held') : `  ✗ ${reason}`);
  if (!proved) {
    await showCaption(page, step.index, total, step.narration, true);
    await page.waitForTimeout(FAIL_HOLD_MS);
  }
  return proved;
}

/**
 * Drive `demo` against a fresh recorded context and finish the MP4. Records the start
 * time of each segment (cover, each step, the closing card), so the optional narration
 * track can be laid down aligned to what is on screen.
 */
export async function captureWalkthrough(opts: CaptureWalkthroughOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  requireFfmpeg(); // fail early with the provisioning hint
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;

  const slug = outputSlug(path.basename(opts.outputPath, path.extname(opts.outputPath)));
  const capturesDir = path.join(opts.captureRoot ?? process.cwd(), '.captures', `${slug}-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });

  const launched = !opts.browser;
  const browser = opts.browser ?? (await chromium.launch({ headless: !opts.headed, args: chromiumLaunchArgs() }));
  const context = await browser.newContext({ viewport: VIEWPORT, recordVideo: { dir: capturesDir, size: VIEWPORT } });
  const page = await context.newPage();
  await installPointer(page);

  const marks: SegMark[] = [];
  const t0 = Date.now();
  const at = (): number => Date.now() - t0;
  let failures = 0;
  let webmPath: string | null = null;

  try {
    await page.goto(joinUrl(opts.baseUrl, demo.start), { waitUntil: 'load' });
    marks.push({ narration: demo.title, at: at() });
    await showCardOverlay(page, coverInnerHtml(BRAND, demo.title, demo.description, `${demo.steps.length} steps`), COVER_MS);

    for (const step of demo.steps) {
      marks.push({ narration: step.narration, at: at() });
      const proved = await walkStep(page, opts.baseUrl, step, demo.steps.length, log);
      if (!proved) failures++;
    }

    marks.push({ narration: demo.scrutiny.length ? 'What to check critically' : '', at: at() });
    if (demo.scrutiny.length) await showCardOverlay(page, scrutinyInnerHtml(demo.scrutiny), Math.min(14000, Math.max(6000, demo.scrutiny.length * 2500)));
    else await page.waitForTimeout(TAIL_MS);
  } finally {
    // Closing the context is what flushes the .webm; the path resolves after.
    const video = page.video();
    await context.close();
    webmPath = video ? await video.path() : null;
    if (launched) await browser.close();
  }
  const endMs = at();

  if (!webmPath) throw new Error('walkthrough: recording produced no video (recordVideo did not write a file)');

  // Segment durations (seconds) between consecutive marks; the last runs to the end.
  const durations = marks.map((m, i) => Math.max(0.5, ((marks[i + 1]?.at ?? endMs) - m.at) / 1000));

  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-wt-'));
  try {
    const silent = path.join(tmp, 'silent.mp4');
    log(`walkthrough: transcoding recording → ${path.basename(opts.outputPath)}`);
    run(['-y', '-i', webmPath, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-an', silent]);

    let audioPath: string | null = null;
    let narrated = false;
    if (!opts.noNarrate) {
      const track = await buildNarration(marks.map((m, i) => ({ narration: m.narration, minDuration: durations[i] })), { stretch: false }, tmp, log);
      audioPath = track?.audioPath ?? null;
      narrated = Boolean(track);
    }
    let music = false;
    if (opts.musicPath) {
      const mixed = mixMusicBed(audioPath, opts.musicPath, endMs / 1000, tmp, log);
      music = mixed !== null && mixed !== audioPath;
      audioPath = mixed;
    }

    const muxed = muxOrCopy(silent, audioPath, opts.outputPath, log);

    // Write a manifest for the kept working dir so a run is inspectable.
    writeFileSync(
      path.join(capturesDir, 'manifest.json'),
      JSON.stringify({ title: demo.title, mode: 'walkthrough', video: path.basename(webmPath), segments: marks.map((m, i) => ({ narration: m.narration, duration: durations[i] })), ...(demo.scrutiny.length ? { scrutiny: demo.scrutiny } : {}) }, null, 2),
    );

    const keep = opts.keep || failures > 0;
    if (!keep) rmSync(capturesDir, { recursive: true, force: true });
    return { outputPath: opts.outputPath, narrated: muxed && narrated, music: muxed && music, failures, capturesDir: keep ? capturesDir : null };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
