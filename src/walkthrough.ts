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
// An iOS app is connected to before the recording starts (connectSurface), because a
// recording films from the page's first frame and connecting takes seconds.
//
// Given a screenshot directory, it saves a PNG of the state each step leaves
// (screenshot.ts) in the page it films. That page alone holds the app's state, since
// another page would have to drive the app again, so a still that leaves out the engine's
// chrome is a frame the filmed page draws, and the recording can show it. An iOS app's
// still is the device's own screenshot, which changes nothing in the page, so the video
// cuts nothing for it. The video cuts
// the frames of the stretch in which each still is taken, reaching a little before the
// still and a little past the first frame of the recording that shows the walkthrough
// again (stillCuts). A still waits for the animations running in the page to end, the
// engine's as well as the app's, and the engine changes nothing else the video can show
// for a while on either side of it. So unless the app moves on its own, the page holds
// one state on both sides of a cut, and the video runs on as if no still were taken. Each
// mark the narration is laid on moves up by the frames the cuts before it drop.

import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright';

import { parseDemoScript, outputSlug, type Demo, type DemoStep, type ViewportSize } from './demo-script.ts';
import { requireFfmpeg, run, probeDuration, buildNarration, mixMusicBed, muxOrCopy } from './ffmpeg.ts';
import { installPointer, runStep, connectSurface, chromiumLaunchArgs, contextOptions, videoFrame, type Surface, type SurfaceConnection } from './browser.ts';
import { showCaption, markFrame, removeMarker, coverInnerHtml, scrutinyInnerHtml, showCardOverlay } from './overlay.ts';
import { stepScreenshots, type StepScreenshots } from './screenshot.ts';
import { capturesRoot, type CaptureResult } from './capture.ts';

const BRAND = 'sprintshow · walkthrough';
const COVER_MS = 3800;
const FAIL_HOLD_MS = 1400; // let a failed step's red badge read before moving on
const TAIL_MS = 1600; // a beat at the end when there is no scrutiny card

export interface CaptureWalkthroughOptions {
  /** Reuse a browser (left open). Omit to launch and close one. */
  browser?: Browser;
  /** Origin a page script's start path is joined onto, or an iOS app script's simulator URL. A terminal script needs none. */
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
export interface Still {
  from: number;
  to: number;
}

/**
 * How long each frame of a recording lasts, in ms. Playwright films a page at 25 frames a
 * second, so the recording's frame `n` lies `n * FRAME_MS` from its start.
 */
const FRAME_MS = 40;

/** The frames a video cuts from its recording, from `first` to `last`, numbered from the recording's first frame, 0. */
export interface Cut {
  first: number;
  last: number;
}

/**
 * How far, in ms, a cut reaches past each end of a still's stretch, so that it takes in
 * every frame of the still, which the recording can show some way from when the browser
 * drew it: from up to 60 ms before to 20 ms after. The reach is several times that, and
 * it costs the video nothing unless the app moves on its own. A still waits for the
 * animations running in the page to end, the engine's as well as the app's, for up to a
 * second (screenshot.ts). From then until QUIET_MS past the frame that shows the
 * walkthrough again, the engine changes nothing the video can show but the still, so the
 * frames the reach takes in show the page as the frames on both sides of the cut show it.
 */
const CUT_REACH_MS = 200;

/**
 * How long the engine changes nothing in the page before a screenshot is taken, once the
 * animations running in it have ended, and after it, once the recording shows the
 * walkthrough again: longer than a cut reaches, by two frames, so the frames on both sides
 * of a cut show the page in one state.
 */
const QUIET_MS = CUT_REACH_MS + 2 * FRAME_MS;

/** How long a screenshot waits for a frame that shows the walkthrough again to reach the recording, and how many it draws. */
const RESHOW_WAIT_MS = 250;
const RESHOW_TRIES = 8;

/**
 * The cuts for `stills` from a recording that starts at `start`, in wall-clock ms: each
 * takes in every frame of the recording that lies within CUT_REACH_MS of its still's
 * stretch.
 */
export function stillCuts(stills: Still[], start: number): Cut[] {
  const frame = (wall: number): number => (wall - start) / FRAME_MS;
  return stills.map((s) => ({ first: Math.ceil(frame(s.from - CUT_REACH_MS)), last: Math.floor(frame(s.to + CUT_REACH_MS)) }));
}

/**
 * Where `at`, in ms from a recording's start, falls in its video once `cuts` are taken out:
 * earlier by a frame for each frame they drop that starts before `at`.
 */
export function afterCuts(at: number, cuts: Cut[]): number {
  const before = Math.ceil(at / FRAME_MS);
  return at - FRAME_MS * cuts.reduce((dropped, c) => dropped + Math.max(0, Math.min(c.last + 1, before) - c.first), 0);
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
export async function screenshotStep(page: Page, surface: Surface, shots: StepScreenshots, recording: RecordingFrames, step: DemoStep, log: (m: string) => void): Promise<Still> {
  await surface.settle();
  const from = await shots.take(page, surface, step, QUIET_MS);
  const shown = (await markFrame(page)) ?? Date.now();
  try {
    for (let tries = 0; tries < RESHOW_TRIES; tries++) {
      await markFrame(page);
      for (const until = Date.now() + RESHOW_WAIT_MS; Date.now() < until; await page.waitForTimeout(25)) {
        const to = recording.firstFrom(shown);
        if (to !== null) {
          await page.waitForTimeout(QUIET_MS);
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
 * directory, it saves each step's screenshot once the step is walked, and cuts from the
 * video the stretch in which each is taken. A capture that throws keeps none of the
 * screenshots it saved.
 */
export async function captureWalkthrough(opts: CaptureWalkthroughOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  requireFfmpeg(); // fail early with the provisioning hint
  const demo = typeof opts.demo === 'string' ? parseDemoScript(opts.demo) : opts.demo;
  // Read before anything is written or launched: a device the registry does not hold throws here.
  const device = contextOptions(demo);
  const frameSize = videoFrame(demo);
  const shots = opts.screenshotDir ? stepScreenshots(demo, opts.screenshotDir, log, [opts.outputPath, capturesRoot(opts.captureRoot)]) : null;
  try {
    return await walkthroughVideo(opts, demo, device, frameSize, shots, log);
  } catch (e) {
    shots?.discard();
    throw e;
  }
}

async function walkthroughVideo(opts: CaptureWalkthroughOptions, demo: Demo, device: BrowserContextOptions, frameSize: ViewportSize, shots: StepScreenshots | null, log: (m: string) => void): Promise<CaptureResult> {
  const slug = outputSlug(path.basename(opts.outputPath, path.extname(opts.outputPath)));
  const capturesDir = path.join(capturesRoot(opts.captureRoot), `${slug}-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  mkdirSync(path.dirname(path.resolve(opts.outputPath)), { recursive: true });

  const launched = !opts.browser;
  const browser = opts.browser ?? (await chromium.launch({ headless: !opts.headed, args: chromiumLaunchArgs() }));
  let connection: SurfaceConnection | null = null;
  let context: BrowserContext | null = null;
  try {
    connection = await connectSurface(demo, { baseUrl: opts.baseUrl, cwd: opts.cwd, log });
    context = await browser.newContext({ ...device, recordVideo: { dir: capturesDir, size: frameSize } });
  } catch (e) {
    await connection?.close();
    if (launched) await browser.close();
    throw e;
  }
  const page = await context.newPage();
  const recording = await watchRecording(page);
  const openedAt = Date.now();
  await installPointer(page);

  // Each segment, with a wall-clock time: for a step, when the browser first showed its
  // caption; for the cover and the closing card, when the page added the card; for a tail
  // with no card, which draws nothing, when it began.
  const segments: { narration: string; wall: number; card: boolean }[] = [];
  const stills: Still[] = [];
  let failures = 0;
  let webmPath: string | null = null;
  let flushedAt = 0;
  let surface: Surface | null = null;

  try {
    surface = await connection.show(page, true);
    const cover = await showCardOverlay(page, coverInnerHtml(BRAND, demo.title, demo.description, `${demo.steps.length} steps`), COVER_MS);
    segments.push({ narration: demo.title, wall: cover, card: true });

    for (const step of demo.steps) {
      const { proved, shownAt } = await walkStep(page, opts.baseUrl ?? '', step, demo.steps.length, log);
      segments.push({ narration: step.narration, wall: shownAt, card: false });
      if (!proved) failures++;
      if (shots && surface.still) {
        await surface.settle();
        await shots.take(page, surface, step);
      } else if (shots) {
        stills.push(await screenshotStep(page, surface, shots, recording, step, log));
      }
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
      // The surface ends once the recording is flushed, so a program slow to end, or a
      // device put back as it was given, is not filmed.
      try {
        await surface?.close();
      } finally {
        await connection?.close();
        if (launched) await browser.close();
      }
    }
  }

  if (!webmPath) throw new Error('walkthrough: recording produced no video (recordVideo did not write a file)');

  const firstFrame = recording.start();
  if (firstFrame === null) log(`walkthrough: no frame of the recording reached the engine, so the narration${stills.length ? " and the screenshots' cuts are" : ' is'} timed from when the page opened`);
  const start = firstFrame ?? openedAt;
  const cuts = stillCuts(stills, start);
  // A segment starts with the frame that first shows it, so neither the time an evaluate
  // takes to reach a busy page nor the time a loaded browser takes to draw counts against
  // its clip. A caption's frame is the one the browser reported. A card can fade in, and
  // the browser reports no frame for text it first paints unseen, so a card starts with
  // the first frame the browser drew after the page added it. That is the card's frame
  // unless the page was drawing frames of its own then. The page, the browser and the
  // engine all tell the host's wall-clock time, so every time is read against the
  // recording's start, and moved up past the frames the cuts before it drop.
  const marks = segments.map((s) => ({ narration: s.narration, at: afterCuts(((s.card ? recording.firstFrom(s.wall) : null) ?? s.wall) - start, cuts) }));

  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-wt-'));
  try {
    const silent = path.join(tmp, 'silent.mp4');
    log(`walkthrough: transcoding recording → ${path.basename(opts.outputPath)}`);
    // The filter drops each cut's frames by their number, and retimes the frames after a
    // cut to follow the frame before it.
    const cut = cuts.length ? `select='not(${cuts.map((c) => `between(n,${c.first},${c.last})`).join('+')})',setpts=N/FRAME_RATE/TB,` : '';
    run(['-y', '-i', webmPath, '-vf', `${cut}scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p`, '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-an', silent]);

    // The transcode is the picture the MP4 shows, so its length ends the last slot. ffmpeg
    // prints the length of a file it wrote, and the time the flush ended, moved up past
    // the frames the cuts drop, stands in only when the probe reads none.
    const endMs = Math.round(probeDuration(silent) * 1000) || afterCuts(flushedAt - start, cuts);
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
      JSON.stringify({ title: demo.title, mode: 'walkthrough', video: path.basename(webmPath), segments: slots, ...(cuts.length ? { cuts } : {}), ...(demo.scrutiny.length ? { scrutiny: demo.scrutiny } : {}) }, null, 2),
    );

    const keep = opts.keep || failures > 0;
    if (!keep) rmSync(capturesDir, { recursive: true, force: true });
    return { outputPath: opts.outputPath, narrated: muxed && narrated, music: muxed && music, failures, capturesDir: keep ? capturesDir : null, screenshots: shots ? [...shots.saved] : [] };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
