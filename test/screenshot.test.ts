// Tests for the screenshot capture: the driver (captureScreenshot in src/screenshot.ts)
// and the `sprintshow screenshot` command over it.
//
// The capture drives a demo script's steps through the step runner, then saves the state
// the last step leaves as one PNG, with nothing of the engine's drawn into it. The
// command exits 0 when every proof held, 3 when the PNG is saved but a proof failed, and
// 1 when no PNG is saved, and it runs with no ffmpeg reachable. A capture that fails once
// the steps have run says how many of their proofs failed. A full-page capture of a page
// larger than one capture holds keeps its top, each row of it drawn in tiles of either
// size Chromium draws in, and says so, and the limit it stops at ends inside what
// Chromium drew of captures that asked for more. One of a page too wide at its scale for
// one capture to hold a row of it saves nothing, and says the scale is too large.
//
// The tests that drive a page need a headless Chromium and skip without one (see
// browser-fixture.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { captureHeightLimit, captureScreenshot, AREA_CONFLICT } from '../src/screenshot.ts';
import { ensureServer } from '../src/server.ts';
import { launchBrowser, serveSite, scratchDir, writeFiles, runCli, stepLines, pngSize, pngPixels, rgba, alphaAt, HIGH_DPI_ARGS, REPO } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const SAMPLE = path.join(REPO, 'demos', 'sample.md');
const SAMPLE_APP = path.join(REPO, 'examples', 'sample-app');
const quiet = (): void => {};

/**
 * How many pixels of two same-size PNGs differ by more than `tolerance` in any channel.
 * Chromium's anti-aliasing of a rounded edge can vary by a level between two captures
 * of one unchanged page, so equal bytes are not the test of an unchanged page.
 */
async function pixelsApart(page: Page, a: Buffer, b: Buffer, tolerance: number): Promise<number> {
  const [pa, pb] = [(await rgba(page, a)).data, (await rgba(page, b)).data];
  assert.equal(pa.length, pb.length, 'the PNGs differ in size');
  let n = 0;
  for (let i = 0; i < pa.length; i += 4) {
    if (Math.max(Math.abs(pa[i] - pb[i]), Math.abs(pa[i + 1] - pb[i + 1]), Math.abs(pa[i + 2] - pb[i + 2]), Math.abs(pa[i + 3] - pb[i + 3])) > tolerance) n++;
  }
  return n;
}

/** Drive the bundled sample with `captureScreenshot` on a fresh page at scale 1, then hand the page to `inspect`. */
async function captureSample(opts: { selector?: string }, inspect: (page: Page, png: string, lines: string[], failures: number) => Promise<void>): Promise<void> {
  const server = await ensureServer({ serveDir: SAMPLE_APP, log: quiet });
  const { dir, cleanup } = scratchDir();
  const page = await browser!.newPage();
  try {
    const png = path.join(dir, 'sample.png');
    const lines: string[] = [];
    const res = await captureScreenshot({ page, baseUrl: server.baseUrl, demo: readFileSync(SAMPLE, 'utf8'), outputPath: png, selector: opts.selector, log: (m) => lines.push(m) });
    assert.equal(res.outputPath, png);
    await inspect(page, png, lines, res.failures);
  } finally {
    await page.close();
    await server.stop();
    cleanup();
  }
}

/** A page taller than the viewport, ending in a marker. */
const TALL_HTML = '<!doctype html><body style="margin:0"><div style="height:2000px"></div><p id="end" style="margin:0">end</p></body>';

const TALL = `# Demo: Tall page

**Start:** \`/tall.html\`

## Steps

1. **The page is taller than the viewport**
   \`waitFor #end\`
   _Prove:_ the end marker is on the page — \`count #end == 1\`
`;

/** Three hundred bands, 100 px tall, each a colour that encodes its index: n % 256 red, n / 256 green, blue 200. */
const BANDS_HTML = `<!doctype html><body style="margin:0">${Array.from({ length: 300 }, (_, n) => `<div${n === 299 ? ' id="end"' : ''} style="height:100px;background:rgb(${n % 256},${Math.floor(n / 256)},200)"></div>`).join('')}</body>`;

const BANDS = `# Demo: Banded page

**Start:** \`/bands.html\`

## Steps

1. **A page of bands, 30000 px tall**
   \`waitFor #end\`
   _Prove:_ the last band is on the page — \`count #end == 1\`
`;

/** A page 250,000 px wide: at scale 1, one row of 512-pixel tiles across it is more than Chromium's budget. */
const WIDE_HTML = '<!doctype html><body style="margin:0"><div id="end" style="width:250000px;height:10px"></div></body>';

const WIDE = `# Demo: Wide page

**Start:** \`/wide.html\`

## Steps

1. **A page 250000 px wide**
   \`waitFor #end\`
   _Prove:_ the strip across it is on the page — \`count #end == 1\`
`;

/** A rounded card on a page that paints no background of its own. */
const CARD_HTML = '<!doctype html><style>html,body{margin:0;background:transparent}.card{margin:24px;width:160px;height:80px;border-radius:24px;background:#1f6feb}</style><div class="card"></div>';

const CARD = `# Demo: Rounded card

**Start:** \`/card.html\`

## Steps

1. **A rounded card on a page that paints no background**
   \`waitFor .card\`
   _Prove:_ the card shows — \`visible .card\`
`;

/** The card page again, with a step that fails at once: its fail-if matches, so no proof is polled. */
const CARD_FAILS = `# Demo: Rounded card, failing

**Start:** \`/card.html\`

## Steps

1. **The card shows, and the step is made to fail**
   \`waitFor .card\`
   _Fail if:_ the card shows — \`visible .card\`
`;

/** The environment of a host with no ffmpeg anywhere and no narration key: PATH holds nothing, FFMPEG_BIN names no file. */
function noFfmpegEnv(dir: string): NodeJS.ProcessEnv {
  const { OPENAI_API_KEY: _key, FFMPEG_BIN: _bin, ...rest } = process.env;
  return { ...rest, PATH: dir, FFMPEG_BIN: path.join(dir, 'no-ffmpeg-here') };
}

test('the capture height limit ends inside what Chromium drew of captures past its tile budget, in tiles of either size, and keeps those it drew whole', () => {
  // Captures Chromium was asked for whole, each its width in CSS pixels, its scale and the
  // size of the tiles it drew in, with the lowest device-pixel row seen drawn, and whether
  // it left the rows below unpainted. A browser started at scale 2 on macOS drew the
  // captures in 512-pixel tiles.
  const seen = [
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 2, tile: 256, drawn: 51804, cut: true },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 3, tile: 256, drawn: 37050, cut: true },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 4, tile: 256, drawn: 27112, cut: true },
    { what: 'a page 30000 px tall', width: 1280, scale: 2, tile: 256, drawn: 47100, cut: true },
    { what: 'a 40x24 terminal of 1002 lines', width: 606, scale: 2, tile: 256, drawn: 56224, cut: false },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 1, tile: 256, drawn: 28112, cut: false },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 2, tile: 512, drawn: 52020, cut: true },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 3, tile: 512, drawn: 37230, cut: true },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 4, tile: 512, drawn: 26010, cut: true },
    { what: 'a page 30000 px tall', width: 1280, scale: 2, tile: 512, drawn: 43350, cut: true },
    { what: 'a 40x24 terminal of 1002 lines', width: 606, scale: 2, tile: 512, drawn: 56224, cut: false },
    { what: 'an 80x24 terminal of 1002 lines', width: 1184, scale: 1, tile: 512, drawn: 28112, cut: false },
  ];
  for (const c of seen) {
    const bottom = captureHeightLimit(c.width, c.scale) * c.scale;
    const where = `${c.what} at scale ${c.scale} in ${c.tile}-pixel tiles: the limit ends at device row ${bottom}`;
    if (!c.cut) {
      assert.ok(bottom >= c.drawn, where);
      continue;
    }
    // Inside what was drawn. And short of the least that tiles of either size drew of that
    // capture by no more than the sixteenth of the budget a capture leaves unspent, and the
    // tile row the limit rounds down to.
    const least = seen.filter((s) => s.cut && s.width === c.width && s.scale === c.scale).reduce((a, b) => (b.drawn < a.drawn ? b : a));
    assert.ok(bottom <= c.drawn && bottom >= (least.drawn * 15) / 16 - (least.tile - 2), where);
  }
});

// Each test drives a page, a server or a process of its own, so they run side by side.
describe('the screenshot capture', { concurrency: true, skip }, () => {
  test('the sample board is captured after the sample steps, each step reported through the runner', async () => {
    await captureSample({ selector: '#board' }, async (page, png, lines, failures) => {
      assert.equal(failures, 0);
      const steps = stepLines(lines.join('\n'));
      assert.equal(steps.length, 12);
      assert.deepEqual(steps.filter((l) => l.startsWith('  ')), Array(6).fill('  ✓ proof held'));
      assert.equal(lines.at(-1), 'screenshot: capturing `#board` → sample.png');
      assert.match(await page.locator('#summary').innerText(), /3 tasks · 1 done/);
      // An element capture covers every device pixel the element touches, so a box with a
      // fractional edge rounds up by at most one pixel.
      const box = (await page.locator('#board').boundingBox())!;
      const { width, height } = pngSize(png);
      assert.ok(Math.abs(width - box.width) <= 1 && Math.abs(height - box.height) <= 1, `${width}×${height} is not the ${box.width}×${box.height} board`);
    });
  });

  test('the capture draws none of the engine: no caption, pointer or card, and the PNG is the page as it stands', async () => {
    await captureSample({}, async (page, png) => {
      assert.equal(await page.locator('#__ss_caption__, #__ss_pointer__, #__ss_card__').count(), 0);
      assert.deepEqual(pngSize(png), { width: 1280, height: 900 });
      // A caption bar drawn for the capture and removed after it would differ here by whole
      // rows of pixels; the tolerance only absorbs edge anti-aliasing.
      assert.equal(await pixelsApart(page, readFileSync(png), await page.screenshot({ type: 'png' }), 8), 0, 'the saved PNG differs from a plain screenshot of the same page');
    });
  });

  test('--full-page captures the whole scrollable page; the default is the viewport', async () => {
    const site = await serveSite({ 'tall.html': TALL_HTML });
    const page = await browser!.newPage();
    try {
      const full = path.join(site.dir, 'full.png');
      const view = path.join(site.dir, 'view.png');
      await captureScreenshot({ page, baseUrl: site.baseUrl, demo: TALL, outputPath: full, fullPage: true, log: quiet });
      const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
      await captureScreenshot({ page, baseUrl: site.baseUrl, demo: TALL, outputPath: view, log: quiet });
      assert.ok(fullHeight > 2000);
      assert.deepEqual(pngSize(full), { width: 1280, height: fullHeight });
      assert.deepEqual(pngSize(view), { width: 1280, height: 900 });
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('--full-page refuses a page too wide at its scale for one capture to hold a row of it, and saves nothing', async () => {
    const site = await serveSite({ 'wide.html': WIDE_HTML });
    const page = await browser!.newPage();
    try {
      const png = path.join(site.dir, 'wide.png');
      assert.equal(captureHeightLimit(250000, 1), 0);
      await assert.rejects(captureScreenshot({ page, baseUrl: site.baseUrl, demo: WIDE, outputPath: png, fullPage: true, log: quiet }), {
        message: 'screenshot: could not capture the full page: scale 1 is too large for one capture of a page 250000 CSS pixels wide',
      });
      assert.equal(existsSync(png), false);
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('--transparent keeps the corners of a rounded element transparent where the page paints nothing', async () => {
    const site = await serveSite({ 'card.html': CARD_HTML });
    const page = await browser!.newPage();
    try {
      const clear = path.join(site.dir, 'clear.png');
      const opaque = path.join(site.dir, 'opaque.png');
      await captureScreenshot({ page, baseUrl: site.baseUrl, demo: CARD, outputPath: clear, selector: '.card', transparent: true, log: quiet });
      await captureScreenshot({ page, baseUrl: site.baseUrl, demo: CARD, outputPath: opaque, selector: '.card', log: quiet });
      assert.deepEqual(pngSize(clear), { width: 160, height: 80 });
      assert.equal(await alphaAt(page, clear, 0, 0), 0, 'the corner is transparent');
      assert.equal(await alphaAt(page, clear, 80, 40), 255, 'the card itself stays opaque');
      assert.equal(await alphaAt(page, opaque, 0, 0), 255, 'without --transparent the default white background fills the corner');
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('asking for the full page and one element at once is refused before the page is driven', async () => {
    const page = await browser!.newPage();
    const { dir, cleanup } = scratchDir();
    try {
      const png = path.join(dir, 'x.png');
      await assert.rejects(captureScreenshot({ page, baseUrl: 'http://localhost:1', demo: CARD, outputPath: png, fullPage: true, selector: '.card', log: quiet }), { message: AREA_CONFLICT });
      assert.equal(page.url(), 'about:blank');
      assert.equal(existsSync(png), false);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('a selector that never shows saves nothing, and with every proof held the error counts no failures', async () => {
    const site = await serveSite({ 'card.html': CARD_HTML });
    const page = await browser!.newPage();
    try {
      const png = path.join(site.dir, 'x.png');
      await assert.rejects(captureScreenshot({ page, baseUrl: site.baseUrl, demo: CARD, outputPath: png, selector: '#missing', log: quiet }), { message: /^screenshot: no visible `#missing` to capture: / });
      assert.equal(existsSync(png), false);
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('sprintshow screenshot saves the sample board at --scale 2 and exits 0, with no ffmpeg reachable', async () => {
    let base = { width: 0, height: 0 };
    await captureSample({ selector: '#board' }, async (_page, png) => {
      base = pngSize(png);
    });
    const { dir, cleanup } = scratchDir();
    try {
      const png = path.join(dir, 'board.png');
      const res = await runCli(['screenshot', SAMPLE, '--serve-dir', SAMPLE_APP, '--selector', '#board', '--scale', '2', '-o', png], { env: noFfmpegEnv(dir) });
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      assert.equal(stepLines(res.stdout).length, 12);
      assert.match(res.stdout, /✅ screenshot → /);
      const { width, height } = pngSize(png);
      assert.equal(width, base.width * 2);
      assert.ok(Math.abs(height - base.height * 2) <= 2, `height ${height} is not twice ${base.height}`);
    } finally {
      cleanup();
    }
  });

  test('sprintshow screenshot still saves the PNG when a proof fails, and exits 3', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      const sample = readFileSync(SAMPLE, 'utf8');
      const broken = sample.replace('/3 tasks · 1 done/', '/3 tasks · 2 done/');
      assert.notEqual(broken, sample, 'the sample carries the assertion this test makes false');
      writeFiles(dir, { 'broken.md': broken });
      const png = path.join(dir, 'board.png');
      const res = await runCli(['screenshot', path.join(dir, 'broken.md'), '--serve-dir', SAMPLE_APP, '--selector', '#board', '-o', png], { env: noFfmpegEnv(dir) });
      assert.equal(res.code, 3, `${res.stdout}${res.stderr}`);
      assert.ok(stepLines(res.stdout).includes('  ✗ _Prove:_ did not hold: `text #summary ~ /3 tasks · 2 done/`'));
      assert.match(res.stdout, /1 step\(s\) failed their proof/);
      assert.ok(pngSize(png).width > 0);
    } finally {
      cleanup();
    }
  });

  test('sprintshow screenshot passes --full-page and --transparent through to the capture', async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      writeFiles(dir, { 'site/tall.html': TALL_HTML, 'site/card.html': CARD_HTML, 'tall.md': TALL, 'card.md': CARD });
      const site = path.join(dir, 'site');
      const full = await runCli(['screenshot', path.join(dir, 'tall.md'), '--serve-dir', site, '--full-page', '-o', path.join(dir, 'full.png')]);
      assert.equal(full.code, 0, `${full.stdout}${full.stderr}`);
      assert.ok(pngSize(path.join(dir, 'full.png')).height > 2000);
      const clear = await runCli(['screenshot', path.join(dir, 'card.md'), '--serve-dir', site, '--selector', '.card', '--transparent', '-o', path.join(dir, 'clear.png')]);
      assert.equal(clear.code, 0, `${clear.stdout}${clear.stderr}`);
      assert.equal(await alphaAt(page, path.join(dir, 'clear.png'), 0, 0), 0);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('sprintshow screenshot exits 1 and saves nothing without a server or an output path', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      const png = path.join(dir, 'board.png');
      const noServer = await runCli(['screenshot', SAMPLE, '-o', png]);
      assert.equal(noServer.code, 1);
      assert.match(noServer.stderr, /no server/);
      const noOutput = await runCli(['screenshot', SAMPLE, '--serve-dir', SAMPLE_APP]);
      assert.equal(noOutput.code, 1);
      assert.match(noOutput.stderr, /an output path \(-o <file\.png>\) is required/);
      assert.equal(existsSync(png), false);
    } finally {
      cleanup();
    }
  });

  test('sprintshow screenshot exits 1 when the selector never shows, and its error counts the steps whose proof failed', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/card.html': CARD_HTML, 'fails.md': CARD_FAILS });
      const png = path.join(dir, 'x.png');
      const res = await runCli(['screenshot', path.join(dir, 'fails.md'), '--serve-dir', path.join(dir, 'site'), '--selector', '#missing', '-o', png]);
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.ok(stepLines(res.stdout).includes('  ✗ _Fail if:_ condition matched: `visible .card`'));
      assert.match(res.stderr, /screenshot: no visible `#missing` to capture \(1 step\(s\) failed their proof\): /);
      assert.equal(existsSync(png), false);
    } finally {
      cleanup();
    }
  });
});

// On a busy host a capture near the most Chromium draws in one takes tens of seconds, and
// the tests running beside it time out, so these run once they are done, one at a time.
// The shared browser draws in 256-pixel tiles, and the other in 512-pixel tiles, as a
// browser started on a high-DPI screen on macOS does.
for (const tiles of [256, 512]) {
  test(`--full-page keeps the top of a page taller than Chromium draws in one capture, and says so, in a browser that draws in ${tiles}-pixel tiles`, { skip }, async () => {
    const own = tiles === 512 ? (await launchBrowser(HIGH_DPI_ARGS)).browser : null;
    try {
      const site = await serveSite({ 'bands.html': BANDS_HTML });
      const page = await (own ?? browser!).newPage({ deviceScaleFactor: 2 });
      try {
        const out = path.join(site.dir, 'bands.png');
        const lines: string[] = [];
        await captureScreenshot({ page, baseUrl: site.baseUrl, demo: BANDS, outputPath: out, fullPage: true, log: (m) => lines.push(m) });
        const limit = captureHeightLimit(1280, 2);
        assert.equal(lines.at(-1), `screenshot: capturing the page's top ${limit} of its 30000 CSS pixels, the most one capture holds at scale 2 → bands.png`);
        assert.deepEqual(pngSize(out), { width: 2560, height: limit * 2 });
        // Chromium drew every band down to the capture's last row, where the band it cuts through shows.
        const ys = [...Array.from({ length: Math.floor(limit / 100) }, (_, n) => (n * 100 + 50) * 2), limit * 2 - 1];
        const drawn = await pngPixels(out, ys.map((y) => ({ x: 2550, y })));
        const near = (got: number, want: number): boolean => Math.abs(got - want) <= 2;
        const wrong = ys.flatMap((y, i) => {
          const n = Math.floor(y / 200);
          const [red, green, blue] = drawn[i];
          return near(red, n % 256) && near(green, Math.floor(n / 256)) && near(blue, 200) ? [] : [`band ${n} at y ${y}: rgba(${drawn[i].join(', ')})`];
        });
        assert.deepEqual(wrong, []);
      } finally {
        await page.close();
        await site.close();
      }
    } finally {
      await own?.close();
    }
  });
}
