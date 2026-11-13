// Tests for what a run returns (runDemo in src/run.ts, and `sprintshow run` over it): a
// video, screenshots or both, as its caller chooses, for a page script and a terminal
// script, in walkthrough and proof mode.
//
// A run given a screenshot directory saves into it a PNG of the state each step leaves,
// named for the step, as a proof video names its frame of the step. A screenshot shows
// the app alone: the screenshots a run with a video takes match, pixel for pixel, those a
// run with no video takes, in whose page the engine draws nothing, and the last matches
// the PNG `sprintshow screenshot` saves. A still shows none of the engine's chrome, nor
// anything it holds, whatever the page's stylesheet gives the elements it holds. A still
// waits on every animation running in the page, the engine's as well as the app's, and a
// click's ripple has ended longer before the still than a cut reaches. A walkthrough's
// video shows no trace of taking them: it holds the frames of its recording less those it
// cuts for them, every frame from the first step's caption to the closing card shows the
// caption, no frame shows a terminal's window laid out as a still, a step that ends at
// once shows its caption before the cut for its screenshot, a step that moves to another
// page, leaving its caption behind, gets no caption back, and no frame of a page whose
// stylesheet decorates every element shows anything at its top-left corner, where the
// engine's frame marker sits. A cut takes in every frame within reach of its still, and a
// moment after it moves up by the frames it drops. The stretch a still can show ends at a
// frame drawn after the still that the recording has, and frames are drawn until one
// reaches it, on a page whose Content Security Policy refuses an image from a data: URL
// as on any other, and on a page that cannot take the marker.
// A run with no video needs a screenshot directory and refuses the video's options, and a
// directory that holds files, or would also hold the video or the run's working
// directory, is refused before anything is served or made. A run whose proof fails saves
// its screenshots and exits 3, and one that saves nothing keeps none of them, nor the
// directory it made for them.
//
// The tests that drive a page need a headless Chromium and skip without one, and the
// walkthrough's need a real ffmpeg (see browser-fixture.ts and assemble.test.ts). A proof
// run assembles over a stand-in ffmpeg.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, type DemoStep } from '../src/demo-script.ts';
import { runDemo } from '../src/run.ts';
import { afterCuts, captureWalkthrough, screenshotStep, stillCuts, watchRecording, type Cut, type RecordingFrames } from '../src/walkthrough.ts';
import { captureScreenshots, stepFileName, stepScreenshots } from '../src/screenshot.ts';
import { ffmpegBin } from '../src/ffmpeg.ts';
import { markFrame, showCaption } from '../src/overlay.ts';
import { VIEWPORT, installPointer } from '../src/browser.ts';
import { launchBrowser, scratchDir, serveSite, writeFiles, runCli, stubFfmpeg, pngSize, pixelsApart, alphaAt, patchLuma, firstFrame, REPO } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

const SAMPLE = path.join(REPO, 'demos', 'sample.md');
const SAMPLE_APP = path.join(REPO, 'examples', 'sample-app');
const TERMINAL = path.join(REPO, 'demos', 'terminal.md');
const SAMPLE_CLI = path.join(REPO, 'examples', 'sample-cli');
const quiet = (): void => {};

test("a step's screenshot is named for its number, padded so the names sort in step order, and its caption, cut at a word", () => {
  const step = (index: number, narration: string): DemoStep => ({ index, narration, actions: [], description: '', droppedCodes: [] });
  assert.equal(stepFileName(step(1, 'The board boots empty'), 6), '01-the-board-boots-empty.png');
  assert.equal(stepFileName(step(7, 'Space marks it done'), 120), '007-space-marks-it-done.png');
  assert.equal(stepFileName(step(2, 'A caption long enough that its name stops at the last whole word before the limit'), 9), '02-a-caption-long-enough-that-its-name-stops-at-the.png');
  assert.equal(stepFileName(step(4, 'Supercalifragilisticexpialidociousandthensomemorecharacters'), 4), '04-supercalifragilisticexpialidociousandthensomemor.png');
  assert.equal(stepFileName(step(3, '— · —'), 3), '03-step.png');
});

test('a cut takes in every 40 ms frame within 200 ms of its still, and a moment after it moves up by the frames it drops', () => {
  const cuts = stillCuts(
    [
      { from: 11_000, to: 11_070 },
      { from: 15_500.4, to: 15_620 },
    ],
    1_000,
  );
  // Each reaches 200 ms past its still: from 9.8 s to 10.27 s, and from 14.3004 s to 14.82 s, of a recording whose frames lie 40 ms apart.
  assert.deepEqual(cuts, [
    { first: 245, last: 256 },
    { first: 358, last: 370 },
  ]);
  assert.deepEqual(stillCuts([], 1_000), []);
  // Before the first cut, on its first frame, inside it, on the frame after it, between the two, and past both.
  assert.deepEqual(
    [5_000, 9_800, 10_010, 10_280, 12_000, 20_000].map((at) => afterCuts(at, cuts)),
    [5_000, 9_800, 9_770, 9_800, 11_520, 19_000],
  );
});

test("a run with no video needs a screenshot directory and refuses the options only a video takes, before it reads the script", async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const lines: string[] = [];
    const log = (m: string): void => void lines.push(m);
    const script = path.join(dir, 'nowhere.md');
    await assert.rejects(runDemo({ script, noVideo: true, log }), { message: 'run: a run with no video returns its screenshots alone, so it needs a directory for them (--screenshots <dir>)' });
    await assert.rejects(
      runDemo({ script, noVideo: true, screenshotDir: path.join(dir, 'shots'), mode: 'proof', outputPath: path.join(dir, 'x.mp4'), musicPath: 'bed.mp3', noNarrate: true, keep: true, headed: true, log }),
      { message: "run: a run with no video takes none of the video's options; drop --mode, -o, --music, --no-narrate, --keep, --headed" },
    );
    assert.deepEqual(lines, []);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup();
  }
});

test('a run refuses a screenshot directory that holds files, or is a file, before it serves anything', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    writeFiles(dir, { 'shots/mine.txt': 'kept', 'a-file': 'kept' });
    const lines: string[] = [];
    const run = (screenshotDir: string): Promise<unknown> => runDemo({ script: SAMPLE, serveDir: SAMPLE_APP, screenshotDir, noVideo: true, log: (m) => lines.push(m) });
    await assert.rejects(run(path.join(dir, 'shots')), { message: `screenshots: ${path.join(dir, 'shots')} already holds files; name a new or empty directory` });
    await assert.rejects(run(path.join(dir, 'a-file')), { message: `screenshots: ${path.join(dir, 'a-file')} is a file; name a new or empty directory` });
    assert.deepEqual(readdirSync(path.join(dir, 'shots')), ['mine.txt']);
    assert.equal(readFileSync(path.join(dir, 'a-file'), 'utf8'), 'kept');
    assert.ok(!lines.some((l) => l.startsWith('server:')), `nothing was served:\n${lines.join('\n')}`);
  } finally {
    cleanup();
  }
});

test('a run refuses a screenshot directory that would also hold its video, before it serves or makes anything', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const lines: string[] = [];
    const shots = path.join(dir, 'shots');
    const video = path.join(shots, 'demo.mp4');
    await assert.rejects(runDemo({ script: SAMPLE, serveDir: SAMPLE_APP, screenshotDir: shots, outputPath: video, log: (m) => lines.push(m) }), {
      message: `screenshots: ${shots} would also hold ${video}, which the run writes too; name a directory the run writes nothing else into`,
    });
    assert.deepEqual(readdirSync(dir), []);
    assert.ok(!lines.some((l) => l.startsWith('server:')), `nothing was served:\n${lines.join('\n')}`);
  } finally {
    cleanup();
  }
});

test("a run whose server never comes up leaves no screenshot directory behind", async () => {
  const { dir, cleanup } = scratchDir();
  try {
    await assert.rejects(runDemo({ script: SAMPLE, screenshotDir: path.join(dir, 'shots'), noVideo: true, log: quiet }), { message: /^no server: / });
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    cleanup();
  }
});

const KINDS = [
  { kind: 'page', script: SAMPLE, args: ['--serve-dir', SAMPLE_APP] },
  { kind: 'terminal', script: TERMINAL, args: ['--cwd', SAMPLE_CLI] },
];

describe('a run of each kind of script returns a PNG of each step', { concurrency: true, skip }, () => {
  for (const { kind, script, args } of KINDS) {
    test(`a ${kind} script's run saves a PNG of each step, alone or beside a proof video, with nothing of the engine's on it, and the last as \`sprintshow screenshot\` saves it`, async () => {
      const { dir, cleanup } = scratchDir();
      const page = await browser!.newPage();
      try {
        const env = { ...process.env, FFMPEG_BIN: stubFfmpeg(dir), OPENAI_API_KEY: '' };
        const [alone, proof, shot] = await Promise.all([
          runCli(['run', script, ...args, '--screenshots', 'alone', '--no-video'], { cwd: dir, env }),
          runCli(['run', script, ...args, '--mode', 'proof', '--no-narrate', '-o', path.join(dir, 'proof.mp4'), '--screenshots', path.join(dir, 'proof')], { cwd: dir, env }),
          runCli(['screenshot', script, ...args, '-o', path.join(dir, 'last.png')], { cwd: dir, env }),
        ]);
        for (const res of [alone, proof, shot]) assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
        assert.ok(existsSync(path.join(dir, 'proof.mp4')), 'the proof run saved its video');
        assert.match(alone.stdout, /✅ 6 screenshot\(s\) → alone\n/);
        assert.doesNotMatch(alone.stdout, /demo →/, 'the run with no video made none');

        const demo = parseDemoScript(readFileSync(script, 'utf8'));
        const names = demo.steps.map((s) => stepFileName(s, demo.steps.length));
        assert.deepEqual(readdirSync(path.join(dir, 'alone')).sort(), names);
        assert.deepEqual(readdirSync(path.join(dir, 'proof')).sort(), names);
        for (const name of names) {
          const [a, b] = [path.join(dir, 'alone', name), path.join(dir, 'proof', name)];
          assert.deepEqual(pngSize(b), pngSize(a), `${name}: the proof run's PNG is the size of the one with no video`);
          assert.equal(await pixelsApart(page, readFileSync(a), readFileSync(b), 32), 0, `${name}: the proof run's PNG shows what the one with no video shows`);
        }

        const last = path.join(dir, 'alone', names.at(-1) as string);
        assert.deepEqual(pngSize(last), pngSize(path.join(dir, 'last.png')));
        assert.equal(await pixelsApart(page, readFileSync(last), readFileSync(path.join(dir, 'last.png')), 32), 0, "the last step's PNG shows what `sprintshow screenshot` saves");
        if (kind === 'page') assert.deepEqual(pngSize(last), VIEWPORT, 'a page script screenshot is the viewport');
        else assert.equal(await alphaAt(page, last, 0, 0), 0, "a terminal script's screenshot is its window, with its corners transparent");
      } finally {
        await page.close();
        cleanup();
      }
    });
  }
});

/** A white page whose button counts its clicks. The caption bar darkens its foot, and a card covers it in the engine's dark background. */
const COUNTER_HTML =
  '<!doctype html><body style="margin:0;background:#fff;font:20px sans-serif">' +
  '<main id="app" style="height:100vh;box-sizing:border-box;padding:40px"><button id="go">Go</button> <span id="n">0</span></main>' +
  '<script>go.onclick = () => { n.textContent = String(Number(n.textContent) + 1); };</script></body>';

/**
 * The counter page, whose stylesheet decorates its elements: every span with a red block
 * and a red box after its text, and every element with an important red outline. Its own
 * elements sit well below its top-left corner, where the walkthrough draws its marker.
 */
const DECORATED_HTML =
  '<!doctype html><head><style>span { background: red; padding: 20px } span::after { content: "x"; background: red; padding: 20px } ' +
  'body * { outline: 20px solid red !important }</style></head>' +
  '<body style="margin:0;background:#fff;font:20px sans-serif">' +
  '<main id="app" style="height:100vh;box-sizing:border-box;padding:200px 40px 40px"><button id="go">Go</button> <span id="n">0</span></main>' +
  '<script>go.onclick = () => { n.textContent = String(Number(n.textContent) + 1); };</script></body>';

const PAGE_WALK = `# Demo: Screenshots of a walkthrough

**Start:** \`/\`

## Steps

1. **A step that ends at once**
   _Prove:_ the page shows — \`visible #app\`

2. **A click counts one**
   \`click #go\`
   _Prove:_ the count is one — \`text #n ~ "1"\`

## Scrutiny

- Every frame of the steps shows the caption.
`;

/** A second page, in a colour of its own, which a step moves to and so leaves its caption behind. */
const NEXT_HTML = '<!doctype html><body style="margin:0;background:#9cc"><main id="next" style="height:100vh"></main></body>';

/**
 * A walkthrough whose first step moves to the second page. The step waits before it moves,
 * so its caption shows on the first page for some ten frames: a step that moved at once
 * could show it there for less than one, which a recording on a loaded host can miss.
 */
const MOVING_WALK = `# Demo: Screenshots of a walkthrough that moves to another page

**Start:** \`/\`

## Steps

1. **The page moves on**
   \`wait 400\`
   \`goto /next.html\`
   _Prove:_ the next page shows — \`visible #next\`

2. **A step that ends at once**
   _Prove:_ the next page still shows — \`visible #next\`
`;

const TERMINAL_WALK = `# Demo: Screenshots of a terminal walkthrough

**Terminal:** 60x12

## Steps

1. **A step that ends at once**
   _Prove:_ the prompt shows — \`screen ~ "$"\`

2. **A command prints**
   \`run echo hello\`
   _Prove:_ it printed — \`screen ~ /^hello$/\`
`;

/** Walk `demo` with a screenshot directory, take its screenshots again with no video, and check the two sets match before handing the video to `inspect`. */
async function walkWithScreenshots(demo: string, at: { baseUrl?: string; cwd?: string }, inspect: (video: string, capturesDir: string) => void): Promise<void> {
  const { dir, cleanup } = scratchDir();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const video = path.join(dir, 'walk.mp4');
    const walked = await captureWalkthrough({ browser: browser!, ...at, demo, outputPath: video, noNarrate: true, keep: true, captureRoot: dir, screenshotDir: path.join(dir, 'walk'), log: quiet });
    assert.equal(walked.failures, 0);
    const alone = await captureScreenshots({ page, ...at, demo, screenshotDir: path.join(dir, 'alone'), log: quiet });
    const { steps } = parseDemoScript(demo);
    const names = steps.map((s) => stepFileName(s, steps.length));
    assert.deepEqual(walked.screenshots.map((f) => path.basename(f)), names);
    assert.deepEqual(alone.screenshots.map((f) => path.basename(f)), names);
    for (const [i, file] of walked.screenshots.entries()) {
      assert.equal(await pixelsApart(page, readFileSync(file), readFileSync(alone.screenshots[i]), 32), 0, `${path.basename(file)}: the walkthrough's PNG shows what the one with no video shows`);
    }
    inspect(video, walked.capturesDir as string);
  } finally {
    await page.close();
    cleanup();
  }
}

describe('a walkthrough takes its screenshots with no trace in its video', { concurrency: true, skip: skip || needsFfmpeg }, () => {
  test('a page walkthrough is shorter than its recording by its cuts, shows the caption in every frame from the first to the closing card, and shows the caption of a step that ends at once before the cut for its screenshot', { timeout: 300_000 }, async () => {
    const site = await serveSite({ 'index.html': COUNTER_HTML });
    try {
      await walkWithScreenshots(PAGE_WALK, { baseUrl: site.baseUrl }, (video, capturesDir) => {
        // As in walkthrough.test.ts: the cover and the closing card darken the page, and the
        // first caption is the first frame whose foot is dark while the page above is light.
        const frames = patchLuma(video, 320, 300);
        const foot = patchLuma(video, 640, 880);
        const cover = firstFrame(frames, 0, (l) => l < 200, 'the cover');
        const between = firstFrame(frames, cover, (l) => l > 220, 'the page between the cards');
        const captionFrame = foot.find((f, i) => f.t >= between && f.luma < 100 && frames[i].luma > 220);
        assert.ok(captionFrame, `no frame from ${between}s shows the first step's caption`);
        const caption = captionFrame.t;
        const closing = firstFrame(frames, caption, (l) => l < 200, 'the closing card');
        const bare = foot.filter((f) => f.t >= caption && f.t < closing && f.luma >= 100).map((f) => f.t);
        assert.deepEqual(bare, [], `every frame from the first caption at ${caption}s to the closing card at ${closing}s shows the caption`);

        const manifest = JSON.parse(readFileSync(path.join(capturesDir, 'manifest.json'), 'utf8')) as { video: string; cuts: Cut[] };
        const { cuts } = manifest;
        assert.equal(cuts.length, 2, 'the video cuts a stretch for each screenshot');
        // The recording's frames lie 40 ms apart from its start, and the video's match them up to the first cut.
        const cutAt = cuts[0].first * 0.04;
        assert.ok(caption < cutAt, `the first step's caption shows at ${caption}s, before the cut for its screenshot at ${cutAt}s`);
        const recorded = patchLuma(path.join(capturesDir, manifest.video), 320, 300).length;
        const dropped = cuts.reduce((n, c) => n + c.last - c.first + 1, 0);
        assert.equal(frames.length, recorded - dropped, `the video holds ${frames.length} frames: its recording's ${recorded} less the ${dropped} its cuts drop, with no frame in their place`);
      });
    } finally {
      await site.close();
    }
  });

  test('a walkthrough step that moves to another page, and so leaves its caption behind, gets no caption back from its screenshot', { timeout: 300_000 }, async () => {
    const site = await serveSite({ 'index.html': COUNTER_HTML, 'next.html': NEXT_HTML });
    try {
      await walkWithScreenshots(MOVING_WALK, { baseUrl: site.baseUrl }, (video, capturesDir) => {
        // The first page is white and the next one a mid tone, and the caption bar darkens
        // the foot of either. The first step's caption shows on the first page, and the next
        // page has none of its own until the second step's.
        const frames = patchLuma(video, 320, 300);
        const foot = patchLuma(video, 640, 880);
        const cover = firstFrame(frames, 0, (l) => l < 100, 'the cover');
        const between = firstFrame(frames, cover, (l) => l > 220, 'the first page after the cover');
        const captionFrame = foot.find((f, i) => f.t >= between && f.luma < 100 && frames[i].luma > 220);
        assert.ok(captionFrame, `no frame from ${between}s shows the first step's caption`);
        const left = firstFrame(foot, captionFrame.t, (l) => l >= 100, 'the next page without the caption');
        const { segments } = JSON.parse(readFileSync(path.join(capturesDir, 'manifest.json'), 'utf8')) as { segments: { narration: string; start: number }[] };
        const second = segments.find((s) => s.narration === 'A step that ends at once');
        assert.ok(second, 'the manifest has the second step');
        const captioned = foot.filter((f) => f.t >= left && f.t < second.start - 0.05 && f.luma < 100).map((f) => f.t);
        assert.deepEqual(captioned, [], `from the move to the next page at ${left}s to the second step's caption at ${second.start}s, no frame shows a caption`);
      });
    } finally {
      await site.close();
    }
  });

  test("a page walkthrough draws nothing at the page's top-left corner, where its marker sits, on a page whose stylesheet decorates every element", { timeout: 300_000 }, async () => {
    const site = await serveSite({ 'index.html': DECORATED_HTML });
    try {
      await walkWithScreenshots(PAGE_WALK, { baseUrl: site.baseUrl }, (video) => {
        // The cover and the closing card darken the page's top right, which no step's
        // pointer, caption or element reaches. Between the two cards the page is white at
        // its top-left corner, and a red block or outline there is the marker drawn by the
        // page's stylesheet.
        const frames = patchLuma(video, 960, 150);
        const corner = patchLuma(video, 8, 8);
        const cover = firstFrame(frames, 0, (l) => l < 200, 'the cover');
        const between = firstFrame(frames, cover, (l) => l > 220, 'the page between the cards');
        const closing = firstFrame(frames, between, (l) => l < 200, 'the closing card');
        const marked = corner.filter((f) => f.t >= between && f.t < closing && f.luma < 200).map((f) => f.t);
        assert.deepEqual(marked, [], `from the page at ${between}s to the closing card at ${closing}s, every frame shows the page's white at its top-left corner`);
      });
    } finally {
      await site.close();
    }
  });

  test("a terminal walkthrough never shows its window laid out as a still, at the page's top-left corner", { timeout: 300_000 }, async () => {
    const { dir, cleanup } = scratchDir();
    try {
      await walkWithScreenshots(TERMINAL_WALK, { cwd: dir }, (video) => {
        // A still lays the window out at the page's top-left corner, where its title bar's red
        // dot is drawn. The video shows the window centred on the dark backdrop, from the frame
        // that first shows the backdrop there.
        const corner = patchLuma(video, 20, 16);
        const backdrop = firstFrame(corner, 0, (l) => l < 80, 'the backdrop');
        const still = corner.filter((f) => f.t >= backdrop && f.luma >= 80).map((f) => f.t);
        assert.deepEqual(still, [], `from ${backdrop}s, no frame shows the window at the page's top-left corner`);
      });
    } finally {
      cleanup();
    }
  });
});

describe("a walkthrough's screenshot ends the stretch it can show at a frame the recording has", { skip }, () => {
  const STEP = parseDemoScript('# Demo: Hold\n\n**Start:** `/`\n\n## Steps\n\n1. **The page shows**\n   _Prove:_ it shows — `visible #app`\n');
  const bare = { settle: async () => {}, close: async () => {} };

  /** Take the step's screenshot on a page of its own against `recording`, and hand `check` the stretch it can show, the markers the page was given and the log. */
  async function still(recording: RecordingFrames, check: (shown: { from: number; to: number }, markers: number, lines: string[], page: Page) => Promise<void>): Promise<void> {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ viewport: VIEWPORT });
    try {
      await page.setContent('<body style="margin:0;background:#fff"><main id="app">app</main></body>');
      await page.evaluate(() => {
        const w = window as unknown as { __markers: number };
        w.__markers = 0;
        new MutationObserver((records) => records.forEach((r) => r.addedNodes.forEach((n) => void ((n as Element).id === '__ss_mark__' && w.__markers++)))).observe(document.body, { childList: true });
      });
      const lines: string[] = [];
      const shots = stepScreenshots(STEP, path.join(dir, 'shots'), quiet);
      const shown = await screenshotStep(page, bare, shots, recording, STEP.steps[0], (m) => lines.push(m));
      await check(shown, await page.evaluate(() => (window as unknown as { __markers: number }).__markers), lines, page);
    } finally {
      await page.close();
      cleanup();
    }
  }

  test('it draws a frame anew until one drawn after the still reaches the recording, and ends there', async () => {
    let asks = 0;
    let frame = 0;
    // The recording has no frame drawn after the still until it has been asked 25 times.
    const recording: RecordingFrames = { start: () => 0, firstFrom: (wall) => (++asks < 25 ? null : (frame ||= wall + 1)) };
    await still(recording, async (shown, markers, lines, page) => {
      assert.equal(shown.to, frame, 'the stretch ends at the frame the recording has');
      assert.ok(shown.from < shown.to);
      assert.ok(markers >= 3, `it drew a frame anew each time the recording had none (${markers} markers)`);
      assert.deepEqual(lines, [], 'it says nothing of a stretch that ends at a frame of the recording');
      assert.equal(await page.locator('#__ss_mark__').count(), 0, 'the marker leaves the page once the stretch ends');
    });
  });

  test('it gives up, and says the video can show the still, when no frame reaches the recording', { timeout: 60_000 }, async () => {
    const recording: RecordingFrames = { start: () => 0, firstFrom: () => null };
    await still(recording, async (shown, markers, lines) => {
      assert.ok(shown.to >= shown.from);
      assert.ok(markers > 1, `it kept drawing frames (${markers} markers)`);
      assert.equal(lines.at(-1), "walkthrough: no frame drawn after step 1's screenshot reached the recording, so the video can show its page as the screenshot saw it");
    });
  });

  test("it ends at a frame the recording has on a page whose Content Security Policy refuses an image from a data: URL", { timeout: 90_000 }, async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ viewport: VIEWPORT });
    try {
      await page.route('http://own-images.test/', (r) =>
        r.fulfill({ contentType: 'text/html', headers: { 'Content-Security-Policy': "img-src 'self'" }, body: '<body style="margin:0;background:#fff"><main id="app">app</main></body>' }),
      );
      const recording = await watchRecording(page);
      await page.goto('http://own-images.test/');
      const refused = await page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(false);
            img.onerror = () => resolve(true);
            img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
          }),
      );
      assert.ok(refused, 'the page refuses an image from a data: URL');
      const lines: string[] = [];
      const shown = await screenshotStep(page, bare, stepScreenshots(STEP, path.join(dir, 'shots'), quiet), recording, STEP.steps[0], (m) => lines.push(m));
      assert.deepEqual(lines, [], 'it says nothing of a stretch that ends at a frame of the recording');
      assert.equal(recording.firstFrom(shown.to), shown.to, 'the stretch ends at a frame the recording has');
    } finally {
      await page.close();
      cleanup();
    }
  });
});

describe('a still and its marker on a page of their own', { skip }, () => {
  const STEP = parseDemoScript('# Demo: Still\n\n**Start:** `/`\n\n## Steps\n\n1. **The page shows**\n   _Prove:_ it shows — `visible #app`\n');

  test('the marker resolves null on a page that cannot take it, and the stretch a still can show still ends', async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ viewport: VIEWPORT });
    try {
      await page.setContent('<body style="margin:0;background:#fff"><main id="app">app</main></body>');
      await page.evaluate(() => document.body.remove());
      assert.equal(await markFrame(page), null);
      const recording: RecordingFrames = { start: () => 0, firstFrom: (wall) => wall + 1 };
      const bare = { settle: async () => {}, close: async () => {} };
      const shown = await screenshotStep(page, bare, stepScreenshots(STEP, path.join(dir, 'shots'), quiet), recording, STEP.steps[0], quiet);
      assert.ok(shown.from < shown.to, 'the stretch ends at a frame the recording has');
    } finally {
      await page.close();
      cleanup();
    }
  });

  test("a still waits on every animation running in the page: the app's, and the engine's ripple, pointer, caption and card", async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ viewport: VIEWPORT });
    try {
      await page.setContent(
        '<body style="margin:0;background:#fff"><main id="app">app</main><div class="__ss_ripple__">.</div><div id="__ss_pointer__">.</div>' +
          '<div id="__ss_caption__"><span>caption</span></div><div id="__ss_card__">card</div></body>',
      );
      await page.evaluate(() => {
        // Each animation runs ten seconds, past the longest a still waits, and is named for its element.
        const w = window as unknown as { __waited: string[] };
        w.__waited = [];
        const finished = Object.getOwnPropertyDescriptor(Animation.prototype, 'finished') as PropertyDescriptor;
        Object.defineProperty(Animation.prototype, 'finished', {
          get(this: Animation) {
            w.__waited.push(this.id);
            return finished.get?.call(this);
          },
        });
        for (const [selector, id] of [['#app', 'app'], ['.__ss_ripple__', 'ripple'], ['#__ss_pointer__', 'pointer'], ['#__ss_caption__ span', 'caption'], ['#__ss_card__', 'card']]) {
          (document.querySelector(selector) as Element).animate([{ opacity: 1 }, { opacity: 0.5 }], 10_000).id = id;
        }
      });
      await stepScreenshots(STEP, path.join(dir, 'shots'), quiet).take(page, STEP.steps[0]);
      assert.deepEqual((await page.evaluate(() => (window as unknown as { __waited: string[] }).__waited)).sort(), ['app', 'caption', 'card', 'pointer', 'ripple']);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test("a still leaves out the engine's chrome with all it holds, whatever the page's stylesheet gives the elements it holds", async () => {
    // Each rule shows part of an element hidden by its visibility: a child, a
    // pseudo-element, or the element itself as it eases out.
    for (const rule of ['span{visibility:visible}', '*::after{content:"after";visibility:visible}', '*{transition:all 1s!important}']) {
      const { dir, cleanup } = scratchDir();
      const page = await browser!.newPage({ viewport: VIEWPORT });
      try {
        await installPointer(page);
        await page.route('http://chrome.test/', (r) => r.fulfill({ contentType: 'text/html', body: `<style>${rule}</style><body style="margin:0;background:#fff"><main id="app">app</main></body>` }));
        await page.goto('http://chrome.test/');
        const still = async (name: string): Promise<Buffer> => {
          const shots = stepScreenshots(STEP, path.join(dir, name), quiet);
          await shots.take(page, STEP.steps[0]);
          return readFileSync(shots.saved[0]);
        };
        const bare = await still('bare');
        await page.evaluate(() => (window as unknown as { __ss: { moveTo(x: number, y: number): void } }).__ss.moveTo(300, 300));
        await showCaption(page, 1, 1, 'The page shows', false);
        assert.equal(await pixelsApart(page, bare, await still('chrome'), 32), 0, `the caption and the pointer show in a still of a page styled ${rule}`);
      } finally {
        await page.close();
        cleanup();
      }
    }
  });

  test("a walkthrough's still begins once a click's ripple has ended, longer after it than the still's cut reaches", async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ viewport: VIEWPORT });
    try {
      await installPointer(page);
      await page.route('http://ripple.test/', (r) => r.fulfill({ contentType: 'text/html', body: '<body style="margin:0;background:#fff"><main id="app">app</main></body>' }));
      await page.goto('http://ripple.test/');
      // The ripple a walkthrough's click draws, and the time its animation ends, or is cut
      // short as the ripple leaves the page.
      await page.evaluate(() => {
        const w = window as unknown as { __ended?: number; __ss: { ripple(x: number, y: number): void } };
        w.__ss.ripple(200, 200);
        const ripple = document.getAnimations().find((a) => (a as CSSAnimation).animationName === '__ss_r') as Animation;
        const ended = (): void => void (w.__ended = performance.timeOrigin + performance.now());
        ripple.finished.then(ended, ended);
      });
      const recording: RecordingFrames = { start: () => 0, firstFrom: (wall) => wall + 1 };
      const bare = { settle: async () => {}, close: async () => {} };
      const shown = await screenshotStep(page, bare, stepScreenshots(STEP, path.join(dir, 'shots'), quiet), recording, STEP.steps[0], quiet);
      const ended = await page.evaluate(() => (window as unknown as { __ended?: number }).__ended);
      assert.ok(ended !== undefined, 'the ripple ran to its end');
      // The cut reaches 200 ms before the still, the frame before the cut starts up to 40 ms
      // before that, and it shows the page as the browser drew it up to 20 ms earlier still.
      assert.ok(shown.from - ended > 260, `the still began ${Math.round(shown.from - ended)} ms after the ripple ended`);
    } finally {
      await page.close();
      cleanup();
    }
  });
});

/** A one-step script on the card page, whose proof holds or fails at once as asked. */
function cardScript(proof: 'holds' | 'fails'): string {
  const assertion = proof === 'holds' ? '_Prove:_ the card shows — `visible .card`' : '_Fail if:_ the card shows — `visible .card`';
  return `# Demo: Card\n\n**Start:** \`/card.html\`\n\n## Steps\n\n1. **The card shows**\n   \`waitFor .card\`\n   ${assertion}\n`;
}

describe('the run command and its screenshots', { concurrency: true, skip }, () => {
  test("exits 3 when a step's proof fails, with each step's screenshot saved", async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/card.html': '<!doctype html><div class="card">card</div>', 'demo.md': cardScript('fails') });
      const res = await runCli(['run', path.join(dir, 'demo.md'), '--serve-dir', path.join(dir, 'site'), '--screenshots', path.join(dir, 'shots'), '--no-video'], { cwd: dir });
      assert.equal(res.code, 3, `${res.stdout}${res.stderr}`);
      assert.match(res.stdout, /1 step\(s\) failed their proof — the screenshots show the state they left/);
      assert.deepEqual(readdirSync(path.join(dir, 'shots')), ['01-the-card-shows.png']);
    } finally {
      cleanup();
    }
  });

  test('keeps none of its screenshots when it saves no video, nor the directories it made for them', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/card.html': '<!doctype html><div class="card">card</div>', 'demo.md': cardScript('holds') });
      mkdirSync(path.join(dir, 'kept'));
      const failing = path.join(dir, 'ffmpeg-fails.mjs');
      writeFileSync(failing, '#!/usr/bin/env node\nprocess.exit(1);\n', { mode: 0o755 });
      const env = { ...process.env, FFMPEG_BIN: failing, OPENAI_API_KEY: '' };
      const run = (shots: string, output: string): ReturnType<typeof runCli> =>
        runCli(['run', 'demo.md', '--serve-dir', 'site', '--mode', 'proof', '--no-narrate', '-o', output, '--screenshots', shots], { cwd: dir, env });
      const [made, kept] = await Promise.all([run('made/shots', 'made.mp4'), run('kept', 'kept.mp4')]);
      for (const res of [made, kept]) {
        assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
        assert.match(res.stdout, /· screenshot → 01-the-card-shows\.png/, 'the run took the screenshot before its video failed');
      }
      assert.equal(existsSync(path.join(dir, 'made')), false, 'the run removes the directories it made for its screenshots');
      assert.deepEqual(readdirSync(path.join(dir, 'kept')), [], 'the run leaves a directory it did not make, empty');
      assert.equal(existsSync(path.join(dir, 'made.mp4')) || existsSync(path.join(dir, 'kept.mp4')), false);
    } finally {
      cleanup();
    }
  });

  test("names a proof video's frame of each step as it names the step's screenshot", async () => {
    const { dir, cleanup } = scratchDir();
    try {
      const caption = 'The card shows once the page has loaded every part of its content';
      writeFiles(dir, { 'site/card.html': '<!doctype html><div class="card">card</div>', 'demo.md': cardScript('holds').replace('The card shows', caption) });
      const env = { ...process.env, FFMPEG_BIN: stubFfmpeg(dir), OPENAI_API_KEY: '' };
      const res = await runCli(['run', 'demo.md', '--serve-dir', 'site', '--mode', 'proof', '--no-narrate', '--keep', '-o', 'out.mp4', '--screenshots', 'shots'], { cwd: dir, env });
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      const [shot] = readdirSync(path.join(dir, 'shots'));
      const [kept] = readdirSync(path.join(dir, '.captures'));
      const frames = readdirSync(path.join(dir, '.captures', kept));
      assert.ok(frames.includes(shot), `the proof video's frame of the step is named ${shot}: ${frames.join(', ')}`);
    } finally {
      cleanup();
    }
  });

  test('refuses a screenshot directory that would also hold its working directory, making nothing', async () => {
    const { dir, cleanup } = scratchDir();
    const elsewhere = scratchDir();
    try {
      const res = await runCli(['run', SAMPLE, '--serve-dir', SAMPLE_APP, '--screenshots', '.', '-o', path.join(elsewhere.dir, 'demo.mp4')], { cwd: dir });
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /screenshots: .* would also hold .*\/\.captures, which the run writes too/);
      assert.deepEqual(readdirSync(dir), []);
      assert.deepEqual(readdirSync(elsewhere.dir), []);
    } finally {
      elsewhere.cleanup();
      cleanup();
    }
  });

  test('refuses --no-video without --screenshots, and with an option only a video takes, writing nothing', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      const [bare, withOutput] = await Promise.all([
        runCli(['run', SAMPLE, '--serve-dir', SAMPLE_APP, '--no-video'], { cwd: dir }),
        runCli(['run', SAMPLE, '--serve-dir', SAMPLE_APP, '--no-video', '--screenshots', path.join(dir, 'shots'), '-o', path.join(dir, 'out.mp4')], { cwd: dir }),
      ]);
      assert.equal(bare.code, 1, `${bare.stdout}${bare.stderr}`);
      assert.match(bare.stderr, /run: a run with no video returns its screenshots alone, so it needs a directory for them \(--screenshots <dir>\)/);
      assert.equal(withOutput.code, 1, `${withOutput.stdout}${withOutput.stderr}`);
      assert.match(withOutput.stderr, /run: a run with no video takes none of the video's options; drop -o$/m);
      assert.deepEqual(readdirSync(dir), []);
    } finally {
      cleanup();
    }
  });
});
