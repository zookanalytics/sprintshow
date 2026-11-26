// Tests for the chrome a walkthrough draws in the page (src/overlay.ts): the caption bar
// it keeps up through each step (keepCaption), and the cards it shows over the page
// (showCardOverlay).
//
// A kept caption is drawn again in each document the page loads, whether a `goto` or a
// click on a link loads it, in the top frame and in no child frame, and a later kept
// caption replaces it, its failed state included. What a walkthrough's video shows of a
// step that moves to another page is pinned in run.test.ts.
//
// A card fades in and out over the transition it declares, on a page that does nothing
// to compute the card's style before the browser draws it. The recording of such a page
// holds a frame of the card partly faded before the first frame that shows it whole, and
// another after the last.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts). The card's
// test reads the recording's frames with ffmpeg, and skips without it.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import { coverInnerHtml, keepCaption, showCardOverlay } from '../src/overlay.ts';
import { VIEWPORT } from '../src/browser.ts';
import { ffmpegBin } from '../src/ffmpeg.ts';
import { launchBrowser, serveSite, scratchDir, patchLuma, firstFrame } from './browser-fixture.ts';

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

test('a card fades in and out over the transition it declares, so the recording shows it partly faded as it comes and as it goes', { skip: skip || needsFfmpeg }, async () => {
  const { dir, cleanup } = scratchDir();
  const context = await browser!.newContext({ viewport: VIEWPORT, recordVideo: { dir, size: VIEWPORT } });
  try {
    const page = await context.newPage();
    await page.setContent('<!doctype html><body style="margin:0;background:#fff"></body>');
    // The card goes over a page the browser has drawn, as a walkthrough's cover does.
    await page.waitForTimeout(600);
    await showCardOverlay(page, coverInnerHtml('SprintShow', 'A card', '', '1 step'), 1000);
    const video = page.video();
    assert.ok(video, 'the context records the page');
    await context.close();

    // The page is white and the card is the engine's dark background. The patch sits in the
    // card's margin, where its text does not reach, so it shows the page, the card, or the
    // card part of the way through a fade over the page. A page that draws nothing new
    // before the card can send the recording no frame, which then opens as the card fades in.
    const frames = patchLuma(await video.path(), 40, 40);
    const seen = frames.map((f) => `${f.t}s ${f.luma}`).join(', ');
    const whole = firstFrame(frames, 0, (l) => l < 45, 'the card whole');
    const gone = firstFrame(frames, whole, (l) => l > 220, 'the page once the card has gone');
    const partly = (l: number): boolean => l > 60 && l < 200;
    assert.ok(frames.some((f) => f.t < whole && partly(f.luma)), `a frame before the card shows whole, at ${whole}s, shows it partly faded in (${seen})`);
    assert.ok(frames.some((f) => f.t > whole && f.t < gone && partly(f.luma)), `a frame before the page shows again, at ${gone}s, shows the card partly faded out (${seen})`);
  } finally {
    await context.close();
    cleanup();
  }
});
