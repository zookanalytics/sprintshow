// The still-frame ("proof") driver: one screenshot per step, each with its caption
// burned in and its `_Prove:_` assertion checked against the live DOM. This is the
// agent-proof path — deterministic, fast, and the shape an agent produces when it drives
// the browser itself and hands frames to `assemble`.
//
// It accepts a ready page (the Playwright seed-test bootstrap: the caller authenticates
// or arms the app, then hands the page in), so it owns neither the browser nor the
// server — the caller does.

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, slugify, outputSlug, type Demo, type DemoStep } from './demo-script.ts';
import { assembleVideo, type Frame, type Manifest } from './assemble.ts';
import { runAction, awaitAssertion, checkAssertion, joinUrl, PROVE_TIMEOUT, VIEWPORT } from './browser.ts';
import { showCaption, removeCaption, coverInnerHtml, scrutinyInnerHtml, cardDocument } from './overlay.ts';

const BRAND = 'sprintshow · proof';

export interface CaptureProofOptions {
  /** A ready page — already authenticated / on the right origin if the demo needs it. */
  page: Page;
  /** Origin the start path is joined onto. */
  baseUrl: string;
  /** The parsed demo, or a markdown string to parse. */
  demo: Demo | string;
  /** Final mp4 path. */
  outputPath: string;
  noNarrate?: boolean;
  musicPath?: string | null;
  /** Keep the `.captures/<run>/` frames + manifest.json + issues.json on a clean pass. */
  keep?: boolean;
  /** Where the `.captures/<run>/` working dir is created (default: cwd). */
  captureRoot?: string;
  log?: (m: string) => void;
}

export interface CaptureResult {
  outputPath: string;
  narrated: boolean;
  music: boolean;
  /** Steps whose proof failed. Non-zero means the demo showed a broken behaviour. */
  failures: number;
  /** The working dir, if it was kept (a failed run, or `keep`); otherwise null. */
  capturesDir: string | null;
}

interface StepResult {
  frame: Frame;
  issue: { severity: 'error'; step: number; description: string; screenshot: string } | null;
}

async function proofStep(page: Page, base: string, step: DemoStep, total: number, capturesDir: string, log: (m: string) => void): Promise<StepResult> {
  log(`step ${step.index}/${total}: ${step.narration}`);
  for (const act of step.actions) await runAction(page, base, act, false, log);

  // A prove-assertion must become true; a failIf-assertion becoming true overrides it.
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

  const file = `${String(step.index).padStart(2, '0')}-${slugify(step.narration).slice(0, 40)}.png`;
  await showCaption(page, step.index, total, step.narration, !proved);
  await page.screenshot({ path: path.join(capturesDir, file) });
  await removeCaption(page);

  const frame: Frame = {
    file,
    narration: step.narration,
    duration: 3.5,
    observation: proved ? (manual ? 'manual proof (no machine assertion)' : null) : reason,
    proof: proved ? 'passed' : 'failed',
    severity: proved ? null : 'error',
  };
  const issue = proved ? null : { severity: 'error' as const, step: step.index, description: `${step.prove?.prose ?? step.narration} — ${reason}`, screenshot: file };
  return { frame, issue };
}

/** A dark cover card matching the theme, screenshotted as the opening frame. */
async function captureCover(page: Page, demo: Demo, capturesDir: string): Promise<Frame> {
  const meta = `${demo.steps.length} proof steps`;
  await page.setContent(cardDocument(coverInnerHtml(BRAND, demo.title, demo.description, meta)));
  await page.waitForTimeout(150);
  const file = '00-cover.png';
  await page.screenshot({ path: path.join(capturesDir, file) });
  return { file, narration: demo.title, duration: 5, observation: null, proof: 'passed', severity: null };
}

/** A closing card listing the script's `## Scrutiny` items — what a viewer should check critically. */
async function captureScrutiny(page: Page, items: string[], capturesDir: string): Promise<Frame> {
  await page.setContent(cardDocument(scrutinyInnerHtml(items)));
  await page.waitForTimeout(150);
  const file = '99-scrutiny.png';
  await page.screenshot({ path: path.join(capturesDir, file) });
  const duration = Math.min(14, Math.max(6, items.length * 2.5));
  return { file, narration: 'What to check critically', duration, observation: null, proof: 'passed', severity: null };
}

/**
 * Drive `demo` against `page` in still-frame mode and assemble the MP4. Screenshots the
 * steps on the app first, then the cover and scrutiny cards, so the manifest order is
 * cover → steps → scrutiny.
 */
export async function captureProof(opts: CaptureProofOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  const { page, baseUrl } = opts;

  const slug = outputSlug(path.basename(opts.outputPath, path.extname(opts.outputPath)));
  const capturesDir = path.join(opts.captureRoot ?? process.cwd(), '.captures', `${slug}-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });

  await page.setViewportSize(VIEWPORT).catch(() => {});
  await page.goto(joinUrl(baseUrl, demo.start), { waitUntil: 'load' });

  const frames: Frame[] = [];
  const issues: NonNullable<StepResult['issue']>[] = [];
  for (const step of demo.steps) {
    const { frame, issue } = await proofStep(page, baseUrl, step, demo.steps.length, capturesDir, log);
    frames.push(frame);
    if (issue) issues.push(issue);
  }
  const failures = issues.length;

  const cover = await captureCover(page, demo, capturesDir);
  const scrutinyFrame = demo.scrutiny.length ? await captureScrutiny(page, demo.scrutiny, capturesDir) : null;
  const manifest: Manifest = {
    title: demo.title,
    frames: [cover, ...frames, ...(scrutinyFrame ? [scrutinyFrame] : [])],
    ...(demo.scrutiny.length ? { scrutiny: demo.scrutiny } : {}),
  };
  writeFileSync(path.join(capturesDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(capturesDir, 'issues.json'), JSON.stringify(issues, null, 2));

  const result = await assembleVideo({ capturesDir, outputPath: opts.outputPath, noNarrate: opts.noNarrate, musicPath: opts.musicPath, log });

  // A failed run keeps its working dir so issues.json + the proof frames are inspectable;
  // a clean pass cleans up unless asked to keep.
  const keep = opts.keep || failures > 0;
  if (!keep) rmSync(capturesDir, { recursive: true, force: true });

  return { outputPath: result.outputPath, narrated: result.narrated, music: result.music, failures, capturesDir: keep ? capturesDir : null };
}
