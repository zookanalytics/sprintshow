// Tests for capturing a page script at a device's size: contextOptions and videoFrame in
// src/browser.ts, and the captures that make their pages and videos from them.
//
// A page script that names a device is driven in a context made as that device, and a
// `resize` step changes its viewport from that step on. The fixture page lays itself out
// for a phone below 1024px, where a menu button opens a navigation drawer, and for a
// desktop from there up, where a sidebar stands in for both. The screenshots pin the size
// each viewport is captured at and the layout it shows. A named device pins its scale
// factor, touch and user agent. The videos pin that a script that starts at phone width
// and resizes to a desktop's is filmed whole in one frame, as wide as the desktop and as
// tall as the phone, with the phone's viewport at the frame's top-left corner on gray.
//
// The browser-backed tests need a headless Chromium, and the videos a real ffmpeg; they
// skip without them (see browser-fixture.ts and assemble.test.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { devices } from 'playwright';

import { parseDemoScript } from '../src/demo-script.ts';
import { contextOptions, videoFrame, VIEWPORT } from '../src/browser.ts';
import { runDemo, runScreenshot } from '../src/run.ts';
import { ffmpegBin } from '../src/ffmpeg.ts';
import { launchBrowser, scratchDir, writeFiles, runCli, pngSize } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

const BODY = [32, 80, 192];
const DRAWER = [40, 160, 80];
const GRAY = [128, 128, 128];
/** The cover card's background, BG in src/overlay.ts. */
const CARD = [15, 17, 21];

/** A page laid out for a phone below 1024px, with a menu button that opens a drawer, and for a desktop from there up, with a sidebar. */
const NAV_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
html,body{margin:0;height:100%;background:rgb(${BODY});font:16px sans-serif}
#sidebar{position:fixed;left:0;top:0;bottom:0;width:240px;background:rgb(200,120,40)}
#menu{display:none;margin:16px;font:16px sans-serif}
#drawer{display:none;position:fixed;left:0;top:0;bottom:0;width:300px;background:rgb(${DRAWER})}
#drawer.open{display:block}
@media (max-width:1023px){#sidebar{display:none}#menu{display:block}}
</style></head><body>
<nav id="sidebar"><a href="#">Home</a></nav>
<button id="menu">Menu</button>
<nav id="drawer"><a href="#">Home</a></nav>
<script>
const drawer = document.getElementById('drawer');
document.getElementById('menu').addEventListener('click', () => drawer.classList.add('open'));
matchMedia('(min-width: 1024px)').addEventListener('change', (e) => { if (e.matches) drawer.classList.remove('open'); });
</script></body></html>`;

const PHONE_STEPS = `1. **At phone width, a menu button stands in for the sidebar**
   \`waitFor #menu\`
   _Prove:_ the menu button shows — \`visible #menu\`
   _Fail if:_ the sidebar shows — \`visible #sidebar\`

2. **The menu button opens the navigation drawer**
   \`click #menu\`
   _Prove:_ the drawer is open — \`visible #drawer\`
`;

const DESKTOP_STEP = `3. **Widened to a desktop's size, the page shows its sidebar**
   \`resize 1280x800\`
   _Prove:_ the sidebar shows — \`visible #sidebar\`
   _Fail if:_ the menu button still shows — \`visible #menu\`
`;

/** A script on the fixture page at `device`, with `steps`. */
const navScript = (device: string, steps: string): string => `# Demo: Navigation at a phone's width\n\n**Start:** \`/nav.html\`\n**Device:** ${device}\n\n## Steps\n\n${steps}`;

/** At phone width, then resized to a desktop's. */
const NAV = navScript('375x812', `${PHONE_STEPS}\n${DESKTOP_STEP}`);

/** As an iPhone 15, whose viewport is 393x659 at scale 3, with touch. */
const IPHONE = navScript(
  'iphone 15',
  `1. **The page is laid out for the phone's viewport**
   _Prove:_ the viewport is the phone's — \`eval innerWidth === 393 && innerHeight === 659\`

2. **It is drawn at the phone's scale, and takes touch**
   _Prove:_ three device pixels to a CSS pixel, and touch points — \`eval devicePixelRatio === 3 && navigator.maxTouchPoints > 0\`

3. **It tells the page it is an iPhone, which shows its phone layout**
   _Prove:_ the user agent is the phone's — \`eval navigator.userAgent.includes('iPhone')\`
   _Fail if:_ the sidebar shows — \`visible #sidebar\`
`,
);

const quiet = (): void => {};

test('contextOptions makes a named device as the registry describes it, a size as that viewport alone, and no device as VIEWPORT', () => {
  const { defaultBrowserType: _browser, ...iPhone } = devices['iPhone 15'];
  assert.deepEqual(contextOptions(parseDemoScript(IPHONE)), iPhone);
  assert.deepEqual(contextOptions(parseDemoScript(NAV)), { viewport: { width: 375, height: 812 } });
  assert.deepEqual(contextOptions(parseDemoScript(navScript('375x812', PHONE_STEPS).replace('**Device:** 375x812\n', ''))), { viewport: VIEWPORT });
  // A terminal script's frame is the engine's whatever device it names.
  assert.deepEqual(contextOptions(parseDemoScript('# Demo: X\n**Terminal:**\n**Device:** iPhone 15\n## Steps\n1. **s**\n   `run ls`\n')), { viewport: VIEWPORT });
  assert.throws(() => contextOptions(parseDemoScript(navScript('iPhone 99', PHONE_STEPS))), /demo script: \*\*Device:\*\* "iPhone 99" is not a device Playwright describes; the nearest it describes are "iPhone /);
});

test('videoFrame is as wide as the widest viewport the script shows and as tall as the tallest', () => {
  assert.deepEqual(videoFrame(parseDemoScript(NAV)), { width: 1280, height: 812 });
  assert.deepEqual(videoFrame(parseDemoScript(navScript('375x812', PHONE_STEPS))), { width: 375, height: 812 });
  assert.deepEqual(videoFrame(parseDemoScript(IPHONE)), { width: 393, height: 659 });
});

test("sprintshow lint looks a device up in Playwright's registry", async () => {
  const { dir, cleanup } = scratchDir();
  try {
    writeFiles(dir, { 'known.md': navScript('iPhone 15', PHONE_STEPS), 'unknown.md': navScript('iPhone 99', PHONE_STEPS) });
    const known = await runCli(['lint', path.join(dir, 'known.md')], { cwd: dir });
    assert.equal(known.code, 0, `${known.stdout}${known.stderr}`);
    assert.doesNotMatch(known.stdout, /✖/);
    const unknown = await runCli(['lint', path.join(dir, 'unknown.md')], { cwd: dir });
    assert.equal(unknown.code, 1, `${unknown.stdout}${unknown.stderr}`);
    assert.match(unknown.stdout, /✖ script: \*\*Device:\*\* "iPhone 99" is not a device Playwright describes; the nearest it describes are "iPhone \d+", .* — the capture would refuse the script\./);
  } finally {
    cleanup();
  }
});

/** The RGB of the pixel at (x, y) in each frame of `video`, in order. */
function pixelTrack(video: string, x: number, y: number): number[][] {
  const out = execFileSync(ffmpegBin() as string, ['-i', video, '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
  return Array.from({ length: Math.floor(out.length / 3) }, (_, i) => [...out.subarray(i * 3, i * 3 + 3)]);
}

const near = (got: number[], want: number[]): boolean => got.every((c, i) => Math.abs(c - want[i]) <= 20);

/**
 * Check that `video` films NAV whole: it is as wide as the desktop and as tall as the
 * phone, a frame shows the phone layout with gray right of the phone's viewport, and a
 * later frame shows the desktop layout across that width.
 */
function assertFilmsBothLayouts(video: string): void {
  assert.match(spawnSync(ffmpegBin() as string, ['-hide_banner', '-i', video], { encoding: 'utf8' }).stderr, /Video: h264 .*, 1280x812[ ,]/);
  const inPhone = pixelTrack(video, 100, 300);
  const rightOfPhone = pixelTrack(video, 800, 300);
  const phone = rightOfPhone.findIndex((rgb, i) => near(rgb, GRAY) && (near(inPhone[i], BODY) || near(inPhone[i], DRAWER)));
  assert.ok(phone >= 0, 'no frame shows the phone layout with gray right of it');
  const desktop = rightOfPhone.findIndex((rgb, i) => i > phone && near(rgb, BODY));
  assert.ok(desktop > phone, 'no frame after the phone layout shows the desktop layout across the frame');
}

// Each test drives a browser, a server or a process of its own, so they run side by side.
describe('a page script captured at a device size', { concurrency: true, skip }, () => {
  test('a screenshot is the size the script names, in the layout that size shows, and after a resize the size it resized to', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/nav.html': NAV_HTML });
      const site = path.join(dir, 'site');
      const phone = await runScreenshot({ script: parseDemoScript(navScript('375x812', PHONE_STEPS)), serveDir: site, outputPath: path.join(dir, 'phone.png'), log: quiet });
      assert.equal(phone.failures, 0, 'the phone layout shows at 375x812');
      assert.deepEqual(pngSize(phone.outputPath), { width: 375, height: 812 });
      const resized = await runScreenshot({ script: parseDemoScript(NAV), serveDir: site, outputPath: path.join(dir, 'desktop.png'), log: quiet });
      assert.equal(resized.failures, 0, 'the phone layout shows, and then the desktop layout once resized');
      assert.deepEqual(pngSize(resized.outputPath), { width: 1280, height: 800 });
    } finally {
      cleanup();
    }
  });

  test("a named device is emulated: its viewport, scale factor, touch and user agent, and the screenshot is at its scale unless one is given", async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/nav.html': NAV_HTML });
      const site = path.join(dir, 'site');
      const lines: string[] = [];
      const native = await runScreenshot({ script: parseDemoScript(IPHONE), serveDir: site, outputPath: path.join(dir, 'native.png'), log: (m) => lines.push(m) });
      assert.equal(native.failures, 0, lines.join('\n'));
      assert.deepEqual(pngSize(native.outputPath), { width: 393 * 3, height: 659 * 3 });
      const scaled = await runScreenshot({ script: parseDemoScript(IPHONE), serveDir: site, outputPath: path.join(dir, 'scaled.png'), scale: 1, log: quiet });
      assert.deepEqual(pngSize(scaled.outputPath), { width: 393, height: 659 });
    } finally {
      cleanup();
    }
  });

  test('a device the registry does not describe is refused before a server or a browser is started', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/nav.html': NAV_HTML });
      const script = parseDemoScript(navScript('iPhone 99', PHONE_STEPS));
      const lines: string[] = [];
      const refused = /\*\*Device:\*\* "iPhone 99" is not a device Playwright describes/;
      await assert.rejects(runScreenshot({ script, serveDir: path.join(dir, 'site'), outputPath: path.join(dir, 'x.png'), log: (m) => lines.push(m) }), refused);
      await assert.rejects(runDemo({ script, serveDir: path.join(dir, 'site'), mode: 'proof', noNarrate: true, outputPath: path.join(dir, 'x.mp4'), log: (m) => lines.push(m) }), refused);
      assert.deepEqual(
        lines.filter((l) => l.startsWith('server:')),
        [],
      );
    } finally {
      cleanup();
    }
  });
});

// A video's recording and encode keep a busy host's CPU for a minute or more, which slows
// the tests beside them, so these run after the block, one at a time.
for (const mode of ['proof', 'walkthrough'] as const) {
  test(`a ${mode} video of a script that resizes from a phone's width to a desktop's films both layouts whole in one frame`, { skip: skip || needsFfmpeg, timeout: 300_000 }, async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/nav.html': NAV_HTML, 'nav.md': NAV });
      const video = path.join(dir, 'nav.mp4');
      const env = { ...process.env, OPENAI_API_KEY: '' };
      const res = await runCli(['run', path.join(dir, 'nav.md'), '--serve-dir', path.join(dir, 'site'), '--mode', mode, '--no-narrate', '-o', video], { cwd: dir, env });
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      assertFilmsBothLayouts(video);
      // Proof mode captures its cover at the frame's size, so the card fills the frame's
      // last rows, which the desktop's viewport leaves gray.
      if (mode === 'proof') {
        const [cover] = pixelTrack(video, 640, 806);
        assert.ok(near(cover, CARD), `the cover is rgb(${cover.join(', ')}) in the frame's last rows`);
      }
    } finally {
      cleanup();
    }
  });
}
