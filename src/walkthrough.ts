// The walkthrough ("recordVideo") driver: one continuous take of the demo, driven at a
// human pace with the synthetic pointer and live on-screen captions, recorded by
// Playwright and finished into an MP4. This is the library / marketing path — smoother
// and more watchable than the still-frame proof path, at the cost of frame-exact proof
// screenshots.
//
// It still checks each step's `_Prove:_` / `_Fail if:_` assertion, so a failed proof
// shows on screen (a red caption badge) and in the result, rather than being papered
// over by a nice-looking video. A terminal script is filmed the same way, in the engine's
// terminal, with its typing paced for a viewer.
//
// The recorded context emulates the device the script names (contextOptions), and its
// video is filmed in videoFrame's frame, so a script that resizes its viewport keeps
// every size whole in one frame.
//
// Given a screenshot directory, it saves a PNG of the state each step leaves
// (screenshot.ts) in the page it films. A still is taken with the engine's chrome hidden,
// and the browser draws the page as the still sees it, so the frames drawn while one is
// taken, until the browser shows the walkthrough again, are dropped from the video, which
// holds still on the frame before them (heldSpans).

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type Page } from 'playwright';

import { parseDemoScript, outputSlug, type Demo, type DemoStep, type ViewportSize } from './demo-script.ts';
import { requireFfmpeg, run, probeDuration, buildNarration, mixMusicBed, muxOrCopy } from './ffmpeg.ts';
import { installPointer, runStep, openSurface, chromiumLaunchArgs, contextOptions, videoFrame, type Surface } from './browser.ts';
import { showCaption, markFrame, removeMarker, coverInnerHtml, scrutinyInnerHtml, showCardOverlay } from './overlay.ts';
import { stepScreenshots, type StepScreenshots } from './screenshot.ts';
import type { CaptureResult } from './capture.ts';

const BRAND = 'sprintshow · walkthrough';
const COVER_MS = 3800;
const FAIL_HOLD_MS = 1400; // let a failed step's red badge read before moving on
const TAIL_MS = 1600; // a beat at the end when there is no scrutiny card

export interface CaptureWalkthroughOptions {
  /** Reuse a browser (left open). Omit to launch and close one. */
  browser?: Browser;
  /** Origin a page script's start path is joined onto. A terminal script needs none. */
  baseUrl?: string;
  /** The directory a terminal script's shell starts in (default: the working directory). */
  cwd?: string;
  demo: Demo | string;
  outputPath: string;
  noNarrate?: boolean;
  musicPath?: string | null;
  /** Keep the `.captures/<run>/` working dir (the raw .webm + manifest). */
  keep?: boolean;
  captureRoot?: string;
  /** Launch headed (ignored when `browser` is supplied). */
  headed?: boolean;
  /** Also save a PNG of the state each step leaves into this directory, a new or empty one (stepScreenshots). */
  screenshotDir?: string;
  log?: (m: string) => void;
}

/** Where a segment appears: ms from the start of the recording. */
export interface SegMark {
  narration: string;
  at: number;
}

/** What the narration says over a stretch of the recording, in seconds from its start. */
export interface NarrationSlot {
  narration: string;
  start: number;
  duration: number;
}

/**
 * The narration slots of a recording `endMs` long whose segments appear at `marks`. A
 * silent slot runs from the start of the recording to the first mark, each segment's slot
 * runs from its mark to the next one, and the last runs to the end. The slots tile the
 * recording, so each clip starts when its segment appears and the track ends where the
 * recording does. Each bound is held to the recording and rounded to the ms the track is
 * cut in. A slot of no length is dropped, since ffmpeg encodes one as an empty file.
 */
export function narrationSlots(marks: SegMark[], endMs: number): NarrationSlot[] {
  const end = Math.round(endMs);
  const bounds = [{ narration: '', at: 0 }, ...marks].map((m) => ({ narration: m.narration, at: Math.min(Math.max(Math.round(m.at), 0), end) }));
  return bounds
    .map((m, i) => ({ narration: m.narration, start: m.at / 1000, duration: ((bounds[i + 1]?.at ?? end) - m.at) / 1000 }))
    .filter((s) => s.duration > 0);
}

/**
 * A stretch of a recording, in wall-clock ms, that can show a still being taken rather than
 * the walkthrough: from just before the still is taken to the first frame of the recording
 * that shows the walkthrough again.
 */
export interface Hold {
  from: number;
  to: number;
}

/**
 * How far, in seconds, the frames dropped for a hold reach before it and past it. The
 * video shows a frame the browser drew from up to 60 ms before it was drawn to 20 ms
 * after, so each reaches one 40 ms frame further.
 */
const HOLD_LEAD_S = 0.08;
const HOLD_TRAIL_S = 0.04;

/**
 * How long the page shows a step's end before its screenshot is taken: longer than a hold
 * reaches back, by two frames, so the frame the video holds on shows the step's end.
 */
const STILL_QUIET_MS = (HOLD_LEAD_S + 0.08) * 1000;

/**
 * How long the page stays still once the recording shows the walkthrough again after a
 * screenshot: longer than a hold reaches past it, by two frames, so the next frame the
 * page draws lies past the frames it drops.
 */
const RESHOWN_QUIET_MS = (HOLD_TRAIL_S + 0.08) * 1000;

/** How long a screenshot waits for a frame that shows the walkthrough again to reach the recording, and how many it draws. */
const RESHOW_WAIT_MS = 250;
const RESHOW_TRIES = 8;

/**
 * The stretches of a recording that starts at `start`, in wall-clock ms, whose frames are
 * dropped for `holds`: each in seconds from the recording's start, rounded to the ms.
 */
export function heldSpans(holds: Hold[], start: number): { start: number; end: number }[] {
  const at = (wall: number, by: number): number => Math.round(((wall - start) / 1000 + by) * 1000) / 1000;
  return holds.map((h) => ({ start: at(h.from, -HOLD_LEAD_S), end: at(h.to, HOLD_TRAIL_S) }));
}

/** The frames of a page's recording, each by the wall-clock time in ms the browser drew it at. */
export interface RecordingFrames {
  /** The first frame, where the video starts, or null while none has arrived. */
  start(): number | null;
  /** The first frame drawn at or after `wall`, or null when none has been. */
  firstFrom(wall: number): number | null;
}

/**
 * Watch the frames of `page`'s recording. The video opens on the first frame the page
 * shows, which can come well after the page opens, because a page that has not painted
 * may show none. A change the page makes shows from the next frame the browser draws,
 * which under load can also come well after the change. The recording places each frame
 * at the wall-clock time it was drawn, and a screencast client is sent each frame with
 * that time, so this client keeps the times. A client that joins after a frame is sent
 * the last frame shown, which is still the first until the page draws again, so start
 * watching before anything is drawn in the page.
 */
export async function watchRecording(page: Page): Promise<RecordingFrames> {
  const drawn: number[] = [];
  await page.screencast.start({ onFrame: ({ timestamp }) => void drawn.push(timestamp) }).catch(() => {});
  const earliest = (times: number[]): number | null => (times.length ? Math.min(...times) : null);
  return {
    start: () => earliest(drawn),
    firstFrom: (wall) => earliest(drawn.filter((t) => t >= wall)),
  };
}

/** Walk one step, and resolve with whether its proof held and when the browser first showed its caption. */
async function walkStep(page: Page, base: string, step: DemoStep, total: number, log: (m: string) => void): Promise<{ proved: boolean; shownAt: number }> {
  let shownAt = Date.now();
  const { proved } = await runStep(page, base, step, total, true, log, async () => {
    shownAt = await showCaption(page, step.index, total, step.narration, false);
  });
  if (!proved) {
    await showCaption(page, step.index, total, step.narration, true);
    await page.waitForTimeout(FAIL_HOLD_MS);
  }
  return { proved, shownAt };
}

/**
 * Save the screenshot of the step just walked, and return the stretch of the recording
 * that taking it can show. Once the still is taken, a frame that shows nothing new is
 * drawn (markFrame), and every frame drawn after the one the browser first shows it in
 * shows the walkthrough again. A recording places a frame at the time it was drawn, which
 * comes before the time it was shown, and it can miss a frame, holding the still's page
 * for as long as the page draws no other. So such frames are drawn until one drawn after
 * the first reaches the recording.
 */
export async function screenshotStep(page: Page, surface: Surface, shots: StepScreenshots, recording: RecordingFrames, step: DemoStep, log: (m: string) => void): Promise<Hold> {
  await surface.settle();
  const from = await shots.take(page, step, STILL_QUIET_MS);
  const shown = (await markFrame(page)) ?? Date.now();
  try {
    for (let tries = 0; tries < RESHOW_TRIES; tries++) {
      await markFrame(page);
      for (const until = Date.now() + RESHOW_WAIT_MS; Date.now() < until; await page.waitForTimeout(25)) {
        const to = recording.firstFrom(shown);
        if (to !== null) {
          await page.waitForTimeout(RESHOWN_QUIET_MS);
          return { from, to };
        }
      }
    }
    log(`walkthrough: no frame drawn after step ${step.index}'s screenshot reached the recording, so the video can show its page as the screenshot saw it`);
    return { from, to: Date.now() };
  } finally {
    await removeMarker(page);
  }
}

/**
 * Drive `demo` against a fresh recorded context and finish the MP4. Records where each
 * segment (cover, each step, the closing card) appears in the recording, so the optional
 * narration track can be laid on the recording's own timeline. With a screenshot
 * directory, it saves each step's screenshot once the step is walked, and the video holds
 * still while each is taken. A capture that throws keeps none of the screenshots it saved.
 */
export async function captureWalkthrough(opts: CaptureWalkthroughOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  requireFfmpeg(); // fail early with the provisioning hint
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  // Read before anything is written or launched: a device the registry does not hold throws here.
  const device = contextOptions(demo);
  const frameSize = videoFrame(demo);
  const shots = opts.screenshotDir ? stepScreenshots(demo, opts.screenshotDir, log) : null;
  try {
    return await walkthroughVideo(opts, demo, device, frameSize, shots, log);
  } catch (e) {
    shots?.discard();
    throw e;
  }
}

async function walkthroughVideo(opts: CaptureWalkthroughOptions, demo: Demo, device: BrowserContextOptions, frameSize: ViewportSize, shots: StepScreenshots | null, log: (m: string) => void): Promise<CaptureResult> {
  const slug = outputSlug(path.basename(opts.outputPath, path.extname(opts.outputPath)));
  const capturesDir = path.join(opts.captureRoot ?? process.cwd(), '.captures', `${slug}-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });

  const launched = !opts.browser;
  const browser = opts.browser ?? (await chromium.launch({ headless: !opts.headed, args: chromiumLaunchArgs() }));
  const context = await browser.newContext({ ...device, recordVideo: { dir: capturesDir, size: frameSize } });
  const page = await context.newPage();
  const recording = await watchRecording(page);
  const openedAt = Date.now();
  await installPointer(page);

  // Each segment, with a wall-clock time: for a step, when the browser first showed its
  // caption; for the cover and the closing card, when the page added the card; for a tail
  // with no card, which draws nothing, when it began.
  const segments: { narration: string; wall: number; card: boolean }[] = [];
  const holds: Hold[] = [];
  let failures = 0;
  let webmPath: string | null = null;
  let flushedAt = 0;
  let surface: Surface | null = null;

  try {
    surface = await openSurface(page, demo, { baseUrl: opts.baseUrl, cwd: opts.cwd, backdrop: true, log });
    const cover = await showCardOverlay(page, coverInnerHtml(BRAND, demo.title, demo.description, `${demo.steps.length} steps`), COVER_MS);
    segments.push({ narration: demo.title, wall: cover, card: true });

    for (const step of demo.steps) {
      const { proved, shownAt } = await walkStep(page, opts.baseUrl ?? '', step, demo.steps.length, log);
      segments.push({ narration: step.narration, wall: shownAt, card: false });
      if (!proved) failures++;
      if (shots) holds.push(await screenshotStep(page, surface, shots, recording, step, log));
    }

    if (demo.scrutiny.length) {
      const card = await showCardOverlay(page, scrutinyInnerHtml(demo.scrutiny), Math.min(14000, Math.max(6000, demo.scrutiny.length * 2500)));
      segments.push({ narration: 'What to check critically', wall: card, card: true });
    } else {
      segments.push({ narration: '', wall: Date.now(), card: false });
      await page.waitForTimeout(TAIL_MS);
    }
  } finally {
    try {
      // Closing the context is what flushes the .webm; the path resolves after.
      const video = page.video();
      await context.close();
      flushedAt = Date.now();
      webmPath = video ? await video.path() : null;
    } finally {
      // The surface ends once the recording is flushed, so a program slow to end is not filmed.
      await surface?.close();
      if (launched) await browser.close();
    }
  }

  if (!webmPath) throw new Error('walkthrough: recording produced no video (recordVideo did not write a file)');

  const firstFrame = recording.start();
  if (firstFrame === null) log(`walkthrough: no frame of the recording reached the engine, so the narration${holds.length ? " and the screenshots' holds are" : ' is'} timed from when the page opened`);
  const start = firstFrame ?? openedAt;
  // A segment starts with the frame that first shows it, so neither the time an evaluate
  // takes to reach a busy page nor the time a loaded browser takes to draw counts against
  // its clip. A caption's frame is the one the browser reported. A card can fade in, and
  // the browser reports no frame for text it first paints unseen, so a card starts with
  // the first frame the browser drew after the page added it. That is the card's frame
  // unless the page was drawing frames of its own then. The page, the browser and the
  // engine all tell the host's wall-clock time, so every time is read against the
  // recording's start.
  const marks = segments.map((s) => ({ narration: s.narration, at: ((s.card ? recording.firstFrom(s.wall) : null) ?? s.wall) - start }));

  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-wt-'));
  try {
    const silent = path.join(tmp, 'silent.mp4');
    log(`walkthrough: transcoding recording → ${path.basename(opts.outputPath)}`);
    // The MP4 is cut at a constant frame rate, so ffmpeg repeats the frame before each
    // stretch the filter drops, and the video holds still on it.
    const held = heldSpans(holds, start);
    const drop = held.length ? `select='not(${held.map((h) => `between(t,${h.start},${h.end})`).join('+')})',` : '';
    run(['-y', '-i', webmPath, '-vf', `${drop}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-an', silent]);

    // The transcode is the picture the MP4 shows, so its length ends the last slot. ffmpeg
    // prints the length of a file it wrote, and the time the flush ended stands in only
    // when the probe reads none.
    const endMs = Math.round(probeDuration(silent) * 1000) || flushedAt - start;
    const slots = narrationSlots(marks, endMs);

    let audioPath: string | null = null;
    let narrated = false;
    if (!opts.noNarrate) {
      const track = await buildNarration(slots.map((s) => ({ narration: s.narration, minDuration: s.duration })), { stretch: false }, tmp, log);
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
      JSON.stringify({ title: demo.title, mode: 'walkthrough', video: path.basename(webmPath), segments: slots, ...(held.length ? { held } : {}), ...(demo.scrutiny.length ? { scrutiny: demo.scrutiny } : {}) }, null, 2),
    );

    const keep = opts.keep || failures > 0;
    if (!keep) rmSync(capturesDir, { recursive: true, force: true });
    return { outputPath: opts.outputPath, narrated: muxed && narrated, music: muxed && music, failures, capturesDir: keep ? capturesDir : null, screenshots: shots ? [...shots.saved] : [] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
