// Tests for the engine's chrome in a page (src/overlay.ts, and the pointer in
// src/browser.ts).
//
// A kept caption is drawn again in each document the page loads, whether a `goto` or a
// click on a link loads it, in the top frame and in no child frame, and a later kept
// caption replaces it, its failed state included. What a walkthrough's video shows of a
// step that moves to another page is pinned in run.test.ts.
//
// The chrome shows above what the app opens in the browser's top layer, which is drawn
// above every z-index. A walkthrough's video shows its caption, uncovered and unfogged, in
// every frame in which a step has left a popover or a modal dialog open, and its closing
// card over the dialog still open. A proof video's frame of each step shows the caption
// the same way, the pointer glides above a modal dialog, and the caption shows above an
// element the app shows fullscreen. The caption bar lets a click through to the button of
// the app's that it covers. The app styles its popovers and its
// backdrops, and none of that style reaches the layer the chrome is drawn in: with
// nothing of the app's open, the page shows as it is.
//
// A popover or a modal dialog the app opens in a shadow root announces nothing to the
// document. A walkthrough's caption shows above one once the step's action that opened it
// is done. A caption drawn while one is open shows above it, as a proof's frame of a step
// is drawn once the step's actions are done.
//
// They need a headless Chromium, and the videos a real ffmpeg, and skip without them (see
// browser-fixture.ts and assemble.test.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Page } from 'playwright';

import { keepCaption, showCaption, removeCaption } from '../src/overlay.ts';
import { VIEWPORT, glideTo, installPointer, runStep } from '../src/browser.ts';
import { parseDemoScript } from '../src/demo-script.ts';
import { captureWalkthrough } from '../src/walkthrough.ts';
import { captureProof } from '../src/capture.ts';
import { stepFileName } from '../src/screenshot.ts';
import { ffmpegBin } from '../src/ffmpeg.ts';
import { launchBrowser, serveSite, scratchDir, patchLuma, pngPixels, rgba } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

/** What the caption bar in `page`'s top frame shows, or null when it has none. */
function captionOf(page: Page): Promise<{ counter: string; label: string; failed: boolean } | null> {
  return page.evaluate(() => {
    const bar = document.getElementById('__ss_caption__');
    if (!bar) return null;
    const text = (role: string): string => bar.querySelector(`[data-role=${role}]`)?.textContent ?? '';
    return { counter: text('counter'), label: text('label'), failed: (bar.querySelector('[data-role=badge]') as HTMLElement).style.display !== 'none' };
  });
}

test('a kept caption is drawn again in each document the page loads, in its top frame alone, until a later kept caption replaces it', { skip }, async () => {
  const site = await serveSite({
    'index.html': '<!doctype html><body><a id="next" href="/next.html">Next</a></body>',
    'next.html': '<!doctype html><body><iframe src="/inner.html"></iframe><a id="back" href="/">Back</a></body>',
    'inner.html': '<!doctype html><body>Inner</body>',
  });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await page.goto(`${site.baseUrl}/`);
    await keepCaption(page, 1, 2, 'The first step', false);
    await page.goto(`${site.baseUrl}/next.html`);
    assert.deepEqual(await captionOf(page), { counter: '1 / 2', label: 'The first step', failed: false }, 'the page a goto loads shows the caption');
    const inner = page.frames().find((f) => f.url().endsWith('/inner.html'));
    assert.ok(inner, 'the next page holds its iframe');
    assert.equal(await inner.evaluate(() => document.getElementById('__ss_caption__')), null, 'the iframe shows no bar of its own');

    await keepCaption(page, 2, 2, 'The second step', true);
    await Promise.all([page.waitForURL(`${site.baseUrl}/`), page.click('#back')]);
    assert.deepEqual(await captionOf(page), { counter: '2 / 2', label: 'The second step', failed: true }, 'the page a click on a link loads shows the caption kept since, failed as it was kept');
  } finally {
    await page.close();
    await site.close();
  }
});

/**
 * An app that opens a toast and a drawer in the browser's top layer, on a dark grey page.
 * The toast, a manual popover that a `popovertarget` button opens, is white across the
 * foot of the page, under the caption bar, and holds an Undo button there. The drawer, a
 * modal dialog the app's script opens, is white down the left side, and its backdrop fogs
 * the rest of the page. The app gives every popover a transform and every backdrop a fog,
 * as an app may style its own: had the chrome's layer taken the transform, the layer and
 * not the viewport would be the box the caption bar is laid out in, and had it taken the
 * fog, the page would show fogged with nothing of the app's open. Each step that opens
 * one waits a while, so the video shows it under the step's caption.
 */
const TOP_LAYER_APP = `<!doctype html><html><head><style>
body { margin: 0; height: 100vh; background: #444; font: 16px sans-serif; }
[popover] { transform: translateY(0); }
::backdrop { background: rgba(255, 255, 255, 0.5); }
#toast { inset: auto 0 0 0; width: 100%; height: 120px; margin: 0; padding: 0; border: 0; background: #fff; }
#undo { position: absolute; right: 40px; bottom: 20px; }
#drawer { inset: 0 auto 0 0; width: 320px; height: 100vh; max-width: none; max-height: none; margin: 0; padding: 0; border: 0; background: #fff; }
</style></head><body>
<button id="toast-open" popovertarget="toast">Show the toast</button>
<button id="drawer-open">Open the drawer</button>
<div id="toast" popover="manual"><button id="undo">Undo</button></div>
<dialog id="drawer"><p>Drawer</p></dialog>
<script>
  document.getElementById('undo').addEventListener('click', () => document.getElementById('toast').hidePopover());
  document.getElementById('drawer-open').addEventListener('click', () => document.getElementById('drawer').showModal());
</script>
</body></html>`;

const TOP_LAYER_SCRIPT = `# Demo: The app's top layer

**Start:** \`/\`

## Steps

1. **A toast shows at the foot of the page**
   \`click #toast-open\`
   \`wait 800\`
   _Prove:_ the toast shows — \`visible #toast\`

2. **Undo, under the caption bar, takes the click**
   \`click #undo\`
   _Prove:_ the toast is gone — \`hidden #toast\`

3. **A drawer opens over the page**
   \`click #drawer-open\`
   \`wait 800\`
   _Prove:_ the drawer shows — \`visible #drawer\`

## Scrutiny

- The caption shows over the toast and the drawer.
`;

/**
 * Where the frames of TOP_LAYER_APP are read: the toast above the caption bar, the drawer
 * above it, the page beside the drawer, and the caption bar's top padding, which holds no
 * text, under the drawer and beside it. The caption bar is dark over any of them, and
 * the toast, the drawer or the fog would cover it in white or fog it light.
 */
const AT = { toast: { x: 640, y: 800 }, drawer: { x: 160, y: 150 }, page: { x: 1000, y: 400 }, barUnder: { x: 160, y: 850 }, barBeside: { x: 1000, y: 850 } };

/** Luma at or above it is the toast's or the drawer's white, and below it the caption bar shows. */
const WHITE = 200;
const BAR = 100;
/** Luma below it is the page's grey, with no fog over it. */
const UNFOGGED = 115;
/** Luma below it at the drawer and at the page beside it is a card's dark background, which covers the whole page. */
const CARD = 60;

test("a walkthrough's caption shows above the popover and the modal dialog a step opens, and its closing card above the dialog, and the caption bar lets a click through", { skip: skip || needsFfmpeg, timeout: 300_000 }, async () => {
  const site = await serveSite({ 'index.html': TOP_LAYER_APP });
  const { dir, cleanup } = scratchDir();
  try {
    const video = path.join(dir, 'walk.mp4');
    const result = await captureWalkthrough({ browser: browser!, baseUrl: site.baseUrl, demo: parseDemoScript(TOP_LAYER_SCRIPT), outputPath: video, noNarrate: true, captureRoot: dir, log: () => {} });
    assert.equal(result.failures, 0, 'every step held, Undo under the caption bar among them');

    const [toast, drawer, page, barUnder, barBeside] = [AT.toast, AT.drawer, AT.page, AT.barUnder, AT.barBeside].map(({ x, y }) => patchLuma(video, x, y));
    const frames = toast.map((_, i) => i);
    // The recording can start with the blank page, white at every point, before the app
    // draws (walkthrough.test.ts). The steps start once the cover card has shown.
    const cover = frames.find((i) => drawer[i].luma < CARD && page[i].luma < CARD);
    assert.ok(cover !== undefined, 'a frame shows the cover card');
    const toastOpen = frames.filter((i) => i > cover && toast[i].luma >= WHITE);
    const drawerOpen = frames.filter((i) => i > cover && drawer[i].luma >= WHITE);
    assert.ok(toastOpen.length > 0, 'a frame shows the toast');
    assert.ok(drawerOpen.length > 0, 'a frame shows the drawer');
    const covered = [...toastOpen, ...drawerOpen].filter((i) => barUnder[i].luma >= BAR || barBeside[i].luma >= BAR).map((i) => toast[i].t);
    assert.deepEqual(covered, [], 'every frame that shows the toast or the drawer shows the caption bar above it and the fog');

    // Between the toast's going and the drawer's opening, nothing of the app's is open.
    const between = frames.filter((i) => i > toastOpen.at(-1)! && i < drawerOpen[0]);
    assert.ok(between.length > 0, 'frames show the page between the toast and the drawer');
    const fogged = between.filter((i) => page[i].luma >= UNFOGGED || barUnder[i].luma >= BAR || barBeside[i].luma >= BAR).map((i) => toast[i].t);
    assert.deepEqual(fogged, [], 'with nothing of the app\'s open, the page shows unfogged under the caption bar');

    // The drawer stays open to the end, and the closing card, which is dark, shows once the last step is done.
    const closing = frames.find((i) => i > drawerOpen[0] && drawer[i].luma < CARD && page[i].luma < CARD);
    assert.ok(closing !== undefined, 'the closing card shows over the drawer and its backdrop');
  } finally {
    await site.close();
    cleanup();
  }
});

test("a proof video's frame of a step shows the caption above the popover or the modal dialog the step opens", { skip: skip || needsFfmpeg, timeout: 300_000 }, async () => {
  const site = await serveSite({ 'index.html': TOP_LAYER_APP });
  const { dir, cleanup } = scratchDir();
  const tab = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const demo = parseDemoScript(TOP_LAYER_SCRIPT);
    const result = await captureProof({ page: tab, baseUrl: site.baseUrl, demo, outputPath: path.join(dir, 'proof.mp4'), noNarrate: true, keep: true, captureRoot: dir, log: () => {} });
    assert.equal(result.failures, 0);
    const { steps } = demo;
    const points = [AT.toast, AT.drawer, AT.page, AT.barUnder, AT.barBeside];
    const frame = async (i: number): Promise<Record<keyof typeof AT, number>> => {
      const px = await pngPixels(path.join(result.capturesDir as string, stepFileName(steps[i], steps.length)), points);
      const [toast, drawer, page, barUnder, barBeside] = px.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b);
      return { toast, drawer, page, barUnder, barBeside };
    };
    const shown = await frame(0);
    assert.ok(shown.toast >= WHITE, `the first step's frame shows the toast (${shown.toast})`);
    assert.ok(shown.barUnder < BAR && shown.barBeside < BAR, `the first step's frame shows the caption bar above the toast (${shown.barUnder}, ${shown.barBeside})`);
    const gone = await frame(1);
    assert.ok(gone.toast < UNFOGGED && gone.page < UNFOGGED, `with nothing of the app's open, the second step's frame shows the page unfogged (${gone.toast}, ${gone.page})`);
    assert.ok(gone.barUnder < BAR && gone.barBeside < BAR, `the second step's frame shows the caption bar (${gone.barUnder}, ${gone.barBeside})`);
    const opened = await frame(2);
    assert.ok(opened.drawer >= WHITE, `the third step's frame shows the drawer (${opened.drawer})`);
    assert.ok(opened.barUnder < BAR && opened.barBeside < BAR, `the third step's frame shows the caption bar above the drawer and its fog (${opened.barUnder}, ${opened.barBeside})`);
  } finally {
    await tab.close();
    await site.close();
    cleanup();
  }
});

test('the pointer glides above a modal dialog the app opens', { skip }, async () => {
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await installPointer(page);
    const dialog = '<dialog id="d" style="inset:0;margin:0;padding:0;border:0;width:100vw;height:100vh;max-width:none;max-height:none;background:#222"></dialog>';
    await page.route('http://dialog.test/', (r) => r.fulfill({ contentType: 'text/html', body: `<body style="margin:0;background:#fff">${dialog}</body>` }));
    await page.goto('http://dialog.test/');
    await page.evaluate(() => (document.getElementById('d') as HTMLDialogElement).showModal());
    await glideTo(page, 640, 450);
    // The pointer's tip is at the point it glides to, and its white fill 6 px right of it and 7 px below.
    const { width, data } = await rgba(page, await page.screenshot());
    const fill = (457 * width + 646) * 4;
    assert.deepEqual([...data.subarray(fill, fill + 3)], [255, 255, 255], 'the pointer shows its white fill over the dark dialog');
  } finally {
    await page.close();
  }
});

test('the caption bar shows above an element the app shows fullscreen', { skip }, async () => {
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const body = '<body style="margin:0;background:#444"><div id="film" style="height:100px;background:#fff"></div><button id="go">Fullscreen</button>' +
      "<script>document.getElementById('go').addEventListener('click', () => document.getElementById('film').requestFullscreen())</script></body>";
    await page.route('http://fullscreen.test/', (r) => r.fulfill({ contentType: 'text/html', body }));
    await page.goto('http://fullscreen.test/');
    await showCaption(page, 1, 1, 'The film plays fullscreen', false);
    // A click is the user's gesture that a request for fullscreen needs.
    await page.click('#go');
    await page.waitForFunction(() => document.fullscreenElement !== null);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const luma = await screenLuma(page);
    assert.ok(luma(AT.page) >= WHITE, `the film fills the viewport (${luma(AT.page)})`);
    assert.ok(luma(AT.barBeside) < BAR, `the caption bar shows above the film (${luma(AT.barBeside)})`);
  } finally {
    await page.close();
  }
});

/** The luma of each point of `page`, as a screenshot taken now shows it. */
async function screenLuma(page: Page): Promise<(point: { x: number; y: number }) => number> {
  const { width, data } = await rgba(page, await page.screenshot());
  return ({ x, y }) => {
    const at = (y * width + x) * 4;
    return 0.299 * data[at] + 0.587 * data[at + 1] + 0.114 * data[at + 2];
  };
}

/**
 * An app with a sheet, which is a manual popover, and a modal dialog, both in the shadow
 * root of an element of its own, where the browser announces neither opening to the
 * document. Each is white across the foot of the page, where the caption bar is, and above
 * the bar too, at FOOT.
 */
const SHADOW_APP = `<!doctype html><html><body style="margin:0;height:100vh;background:#444">
<x-panel id="panel"></x-panel>
<button id="sheet-open">Open the sheet</button>
<script>
  customElements.define('x-panel', class extends HTMLElement {
    constructor() {
      super();
      const foot = 'inset:auto 0 0 0;width:100%;max-width:none;height:200px;margin:0;padding:0;border:0;background:#fff';
      this.attachShadow({ mode: 'open' }).innerHTML = '<div id="sheet" popover="manual" style="' + foot + '"></div><dialog id="dialog" style="' + foot + '"></dialog>';
    }
  });
  document.getElementById('sheet-open').addEventListener('click', () => document.getElementById('panel').shadowRoot.getElementById('sheet').showPopover());
</script>
</body></html>`;

const FOOT = { x: 640, y: 760 };

const SHADOW_SCRIPT = `# Demo: A sheet in a shadow root

**Start:** \`/\`

## Steps

1. **A sheet opens at the foot of the page**
   \`click #sheet-open\`
   _Prove:_ the sheet shows — \`visible #sheet\`
`;

test("a walkthrough's caption shows above a popover that a step's action opens in a shadow root, once the action is done", { skip }, async () => {
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await installPointer(page);
    await page.route('http://shadow.test/', (r) => r.fulfill({ contentType: 'text/html', body: SHADOW_APP }));
    await page.goto('http://shadow.test/');
    const [step] = parseDemoScript(SHADOW_SCRIPT).steps;
    // This walks the step as a walkthrough does (walkStep in walkthrough.ts), with its caption kept up while its actions run humanized.
    const proof = await runStep(page, 'http://shadow.test', step, 1, true, () => {}, async () => void (await keepCaption(page, step.index, 1, step.narration, false)));
    assert.ok(proof.proved, 'the sheet shows');
    const luma = await screenLuma(page);
    assert.ok(luma(FOOT) >= WHITE, `the sheet shows above the page (${luma(FOOT)})`);
    assert.ok(luma(AT.barBeside) < BAR, `the caption bar shows above the sheet (${luma(AT.barBeside)})`);
  } finally {
    await page.close();
  }
});

test("a caption drawn over a modal dialog the app shows in a shadow root shows above it, as a proof's frame of a step is drawn", { skip }, async () => {
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await page.route('http://shadow.test/', (r) => r.fulfill({ contentType: 'text/html', body: SHADOW_APP }));
    await page.goto('http://shadow.test/');
    // A proof draws each step's caption once the step's actions are done, and removes it
    // once the frame is taken, so the layer the caption is drawn in is up from the first frame on.
    await showCaption(page, 1, 2, 'The panel waits', false);
    await removeCaption(page);
    await page.evaluate(() => (document.getElementById('panel')!.shadowRoot!.getElementById('dialog') as HTMLDialogElement).showModal());
    await showCaption(page, 2, 2, 'The panel shows its dialog', false);
    const luma = await screenLuma(page);
    assert.ok(luma(FOOT) >= WHITE, `the dialog shows above the page (${luma(FOOT)})`);
    assert.ok(luma(AT.barBeside) < BAR, `the caption bar shows above the dialog (${luma(AT.barBeside)})`);
  } finally {
    await page.close();
  }
});
