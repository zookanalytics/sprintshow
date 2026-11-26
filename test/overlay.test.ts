// Tests for the caption bar a walkthrough keeps up through each step (keepCaption in
// src/overlay.ts).
//
// A kept caption is drawn again in each document the page loads, whether a `goto` or a
// click on a link loads it, in the top frame and in no child frame, and a later kept
// caption replaces it, its failed state included. What a walkthrough's video shows of a
// step that moves to another page is pinned in run.test.ts.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';

import { keepCaption } from '../src/overlay.ts';
import { VIEWPORT } from '../src/browser.ts';
import { launchBrowser, serveSite } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

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
