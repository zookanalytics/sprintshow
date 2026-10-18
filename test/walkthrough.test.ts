// Tests for the walkthrough's narration timing (src/walkthrough.ts).
//
// The narration track is laid on the recording's own timeline. The recording starts with
// the first frame the page sends, which can come well after the page opens. A segment
// starts with the frame that first shows it, which can come well after the engine asked
// for it. The browser reports the frame that first shows a caption, and a card starts
// with the first frame drawn after the page added it. The track is silent until the cover
// appears, each clip starts in the frame that first shows its segment, and the last slot
// runs to the end of the recording, so `-shortest` cuts no picture.
//
// narrationSlots is pinned on its own. The recording's frames are pinned against a page
// drawn black at a known time, found in the video. A narrated walkthrough is pinned end to
// end. It opens a page that draws 1 s after it is asked for and loads 1.5 s after that.
// The cover and the caption bar each keep the page busy for 1 s once the page has added
// them. So the recording may start with the blank page or with the page's first frame, the
// cover appears at least 2.5 s in, and the browser draws the cover and the first step's
// caption about 1 s after the page changed, and later still after the engine asked it to.
// A tone stands in for each clip in place of a real voice. The test reads, from the MP4,
// when each tone sounds and when the cover, the first step's caption and the closing card
// show. A step that ends at once comes before the closing card, so a slot held longer than
// its step would show as a late closing clip.
//
// The browser-backed tests need a headless Chromium and a real ffmpeg, and skip without
// them (see browser-fixture.ts and assemble.test.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { captureWalkthrough, narrationSlots, watchRecording } from '../src/walkthrough.ts';
import { ffmpegBin, probeDuration } from '../src/ffmpeg.ts';
import { VIEWPORT } from '../src/browser.ts';
import { launchBrowser, scratchDir } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

test('the slots tile the recording: silent until the first mark, each segment from its mark, the last to the end', () => {
  const marks = [
    { narration: 'Cover', at: 1500.4 },
    { narration: 'Step one', at: 5680 },
    { narration: 'A step that ends at once', at: 6900 },
    { narration: 'Closing', at: 6912 },
  ];
  assert.deepEqual(narrationSlots(marks, 13440), [
    { narration: '', start: 0, duration: 1.5 },
    { narration: 'Cover', start: 1.5, duration: 4.18 },
    { narration: 'Step one', start: 5.68, duration: 1.22 },
    { narration: 'A step that ends at once', start: 6.9, duration: 0.012 },
    { narration: 'Closing', start: 6.912, duration: 6.528 },
  ]);
});

test('a slot of no length is dropped, and a mark outside the recording is held to it', () => {
  assert.deepEqual(
    narrationSlots(
      [
        { narration: 'Cover', at: -30 },
        { narration: 'Same ms', at: 2000 },
        { narration: 'Step', at: 2000.2 },
        { narration: 'Closing', at: 9000 },
      ],
      8000,
    ),
    [
      { narration: 'Cover', start: 0, duration: 2 },
      { narration: 'Step', start: 2, duration: 6 },
    ],
  );
});

/** The time of each frame of `file`, and the mean luma of an 8x8 patch of it centred on (x, y). */
function patchLuma(file: string, x: number, y: number): { t: number; luma: number }[] {
  const res = spawnSync(ffmpegBin() as string, ['-hide_banner', '-i', file, '-an', '-vf', `crop=8:8:${x - 4}:${y - 4},showinfo`, '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return [...res.stderr.matchAll(/pts_time:\s*([\d.]+).*?mean:\[(\d+)/g)].map((m) => ({ t: Number(m[1]), luma: Number(m[2]) }));
}

/** The first frame from `from` on whose patch matches `pred`, or a failure naming `what`. */
function firstFrame(frames: { t: number; luma: number }[], from: number, pred: (luma: number) => boolean, what: string): number {
  const hit = frames.find((f) => f.t >= from && pred(f.luma));
  assert.ok(hit, `no frame from ${from}s shows ${what}`);
  return hit.t;
}

/** The times the audio of `file` sounds after silence, in seconds, and 0 when it opens on sound. */
function onsets(file: string): number[] {
  const res = spawnSync(ffmpegBin() as string, ['-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=n=-40dB:d=0.05', '-f', 'null', '-'], { encoding: 'utf8' });
  const ends = [...res.stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const firstSilence = res.stderr.match(/silence_start: (-?[\d.]+)/);
  return firstSilence && Number(firstSilence[1]) < 0.05 ? ends : [0, ...ends];
}

test('the recording starts at its first frame, and a change the page makes shows in the video from the first frame drawn after it', { skip: skip || needsFfmpeg }, async () => {
  const { dir, cleanup } = scratchDir();
  const context = await browser!.newContext({ viewport: VIEWPORT, recordVideo: { dir, size: VIEWPORT } });
  try {
    const page = await context.newPage();
    const recording = await watchRecording(page);
    // A page that has not drawn may send no frame for this long, and then the recording starts with the black.
    await page.waitForTimeout(600);
    const drawnAt = await page.evaluate(() => {
      document.documentElement.style.background = '#000';
      return performance.timeOrigin + performance.now();
    });
    await page.waitForTimeout(1000);
    const video = page.video();
    assert.ok(video, 'the context records the page');
    await context.close();
    const start = recording.start();
    const shown = recording.firstFrom(drawnAt);
    assert.ok(start !== null && shown !== null, 'the recording has a first frame, and a frame drawn after the page turned black');
    const black = firstFrame(patchLuma(await video.path(), 320, 300), 0, (l) => l < 100, 'the page drawn black');
    // The video is cut in 40 ms frames, and shows a drawn frame from the one that starts at
    // most a little over 40 ms before the frame was drawn.
    const at = (shown - start) / 1000;
    assert.ok(black >= at - 0.06 && black <= at + 0.02, `the frame drawn black is ${at}s into the recording, and the video shows it from ${black}s`);
  } finally {
    await context.close();
    cleanup();
  }
});

// The page answers DRAW_MS after it is asked for, and its image LOAD_MS after that. Once it
// has loaded, the first two things added to it, the cover and the caption bar, each keep
// it busy for BUSY_MS, so the browser draws each that long after the page added it.
const DRAW_MS = 1000;
const LOAD_MS = 1500;
const BUSY_MS = 1000;
const PAGE =
  '<!doctype html><html><body style="margin:0;background:#fff;font:14px sans-serif">' +
  '<main id="app" style="height:100vh">The page draws, then loads once its image has.</main><img src="/slow.png" alt="">' +
  "<script>addEventListener('load', () => { let busy = 2; new MutationObserver((records, observer) => {" +
  'if (!records.some((r) => r.addedNodes.length)) return; if (--busy === 0) observer.disconnect();' +
  `const end = performance.now() + ${BUSY_MS}; while (performance.now() < end);` +
  '}).observe(document.body, { childList: true }); });</script></body></html>';
const SCRIPT = `# Demo: Narration timing

**Start:** \`/\`

## Steps

1. **The page is up**
   \`wait 800\`
   _Prove:_ the page shows — \`visible #app\`

2. **A step that ends at once**
   _Prove:_ the page still shows — \`visible #app\`

## Scrutiny

- Each clip starts with its segment.
`;

/** How far a clip may sit from the frame its segment first shows in. */
const TOLERANCE_S = 0.3;

test('a narrated walkthrough voices each segment when it shows in the recording, and runs its track to the recording\'s end', { skip: skip || needsFfmpeg, timeout: 300_000 }, async () => {
  const { dir, cleanup } = scratchDir();
  // A recording that holds no frame of the blank page starts when the page draws, and the
  // surface opens once the page has loaded.
  const server = createServer((req, res) => {
    if (req.url === '/slow.png') setTimeout(() => res.writeHead(404).end(), LOAD_MS);
    else setTimeout(() => res.writeHead(200, { 'Content-Type': 'text/html' }).end(PAGE), DRAW_MS);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Each clip is a 0.4 s tone, served where the engine asks for speech. The step that ends
  // at once is voiced with silence: its slot is too short to hear, and a tone in it would
  // run on into the closing card's clip, which then could not be told apart.
  const clip = (source: string): Uint8Array<ArrayBuffer> => {
    const file = path.join(dir, 'clip.mp3');
    execFileSync(ffmpegBin() as string, ['-y', '-f', 'lavfi', '-i', `${source}:duration=0.4`, '-c:a', 'libmp3lame', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Uint8Array(readFileSync(file));
  };
  const tone = clip('sine=frequency=880:sample_rate=24000');
  const hush = clip('anullsrc=r=24000:cl=mono');
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
    const text = JSON.parse(String(init?.body)).input as string;
    asked.push(text);
    return new Response(text === 'A step that ends at once' ? hush : tone, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = 'stub';

  try {
    const outputPath = path.join(dir, 'walk.mp4');
    const result = await captureWalkthrough({ browser: browser!, baseUrl, demo: SCRIPT, outputPath, keep: true, captureRoot: dir, log: () => {} });
    assert.equal(result.failures, 0);
    assert.equal(result.narrated, true, 'the walkthrough is narrated');
    assert.deepEqual(asked, ['Narration timing', 'The page is up', 'A step that ends at once', 'What to check critically'], 'each segment was voiced, and the lead-in was not');

    // The page is white, and the cover and the closing card cover it in the engine's dark
    // background, so each card shows from the first frame whose patch darkens. The caption
    // bar darkens the foot of the page. Each clip starts with what it voices.
    const frames = patchLuma(outputPath, 320, 300);
    const cover = firstFrame(frames, 0, (l) => l < 200, 'the cover');
    const between = firstFrame(frames, cover, (l) => l > 220, 'the page between the cards');
    // Near the end of a card's fade-out, a loaded browser can draw one frame with the card
    // darker than in the frame before. So the caption is the first frame whose foot is dark
    // while the page above it is light, and the closing card is looked for once it shows.
    const foot = patchLuma(outputPath, 640, 880);
    const captionFrame = foot.find((f, i) => f.t >= between && f.luma < 100 && frames[i].luma > 220);
    assert.ok(captionFrame, `no frame from ${between}s shows the first step's caption`);
    const caption = captionFrame.t;
    const closing = firstFrame(frames, caption, (l) => l < 200, 'the closing card');
    // A track laid from the cover's mark, as if the recording started there, would run this far ahead.
    assert.ok(cover > (LOAD_MS + BUSY_MS) / 1000 - TOLERANCE_S, `the cover shows once the page has loaded and is no longer busy with it, at ${cover}s`);
    const heard = onsets(outputPath);
    for (const [name, shown] of [['cover', cover], ["first step's caption", caption], ['closing card', closing]] as const) {
      const nearest = heard.reduce((a, b) => (Math.abs(b - shown) < Math.abs(a - shown) ? b : a), Infinity);
      assert.ok(Math.abs(nearest - shown) <= TOLERANCE_S, `the ${name} shows at ${shown}s, and the nearest clip starts at ${nearest}s (clips start at ${heard.join(', ')})`);
    }

    // -shortest keeps the whole picture: the MP4 runs as long as the recording.
    const kept = result.capturesDir as string;
    const recording = path.join(kept, readdirSync(kept).find((f) => f.endsWith('.webm')) as string);
    const length = probeDuration(recording);
    const mp4 = probeDuration(outputPath);
    assert.ok(mp4 >= length - 0.1, `the MP4 lasts ${mp4}s of the ${length}s recording`);

    // The slots the run used tile the recording, from its first frame to its last.
    const { segments } = JSON.parse(readFileSync(path.join(kept, 'manifest.json'), 'utf8')) as { segments: { narration: string; start: number; duration: number }[] };
    assert.equal(segments[0].narration, '', 'the recording opens on a silent slot');
    assert.equal(segments[0].start, 0);
    segments.forEach((s, i) => i && assert.ok(Math.abs(s.start - (segments[i - 1].start + segments[i - 1].duration)) < 0.0005, `slot ${i} starts where slot ${i - 1} ends`));
    const end = segments.at(-1)!.start + segments.at(-1)!.duration;
    assert.ok(Math.abs(end - length) < 0.05, `the slots end at ${end}s, where the ${length}s recording does`);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup();
  }
});
