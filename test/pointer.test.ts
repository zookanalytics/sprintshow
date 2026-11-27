// Tests for the pointer a walkthrough draws (POINTER_INIT, installPointer and glideTo in
// src/browser.ts).
//
// The pointer is drawn by its first glide, so steps that press keys, wait or scroll draw
// none, and the first glide still moves it from where it is drawn to its target. A page
// loaded after a glide holds no pointer until the next one. A child frame, from the page's
// own host or another, holds neither a pointer nor the API that moves one.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Frame, Page } from 'playwright';

import { parseDemoScript } from '../src/demo-script.ts';
import { glideTo, installPointer, runStep, VIEWPORT } from '../src/browser.ts';
import { launchBrowser, serveSite } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const quiet = (): void => {};

/** Where the pointer in `frame` points, the corner of its box less its margin, or null when the frame holds none. */
function pointerIn(frame: Page | Frame): Promise<{ x: number; y: number } | null> {
  return frame.evaluate(() => {
    const el = document.getElementById('__ss_pointer__');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.left + 3), y: Math.round(box.top + 3) };
  });
}

const KEYS = parseDemoScript(`# Demo: Keys

**Start:** \`/\`

## Steps

1. **Keys, a wait and a scroll move no pointer**
   \`waitFor #field\`
   \`press Tab "ship" Enter\`
   \`wait 100\`
   \`scroll #end\`
`);

test("a walkthrough's steps that press keys, wait and scroll draw no pointer", { skip }, async () => {
  const site = await serveSite({ 'index.html': '<!doctype html><body><input id="field"><div style="height:3000px"></div><p id="end">End</p></body>' });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await installPointer(page);
    await page.goto(`${site.baseUrl}/`);
    for (const step of KEYS.steps) assert.equal((await runStep(page, site.baseUrl, step, KEYS.steps.length, true, quiet)).proved, true);
    assert.equal(await page.evaluate(() => scrollY > 0), true, 'the scroll step scrolled the page');
    assert.equal(await pointerIn(page), null);
  } finally {
    await page.close();
    await site.close();
  }
});

test('the first glide draws the pointer 50% across and 45% down and moves it from there, and a page loaded after it holds none until the next glide', { skip }, async () => {
  const site = await serveSite({ 'index.html': '<!doctype html><body>One</body>', 'next.html': '<!doctype html><body>Two</body>' });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await installPointer(page);
    await page.goto(`${site.baseUrl}/`);
    // Where the pointer is as its glide begins, read in the task that starts it.
    const start = await page.evaluate(() => {
      (window as unknown as { __ss: { moveTo(x: number, y: number): void } }).__ss.moveTo(100, 120);
      const box = (document.getElementById('__ss_pointer__') as HTMLElement).getBoundingClientRect();
      return { x: Math.round(box.left + 3), y: Math.round(box.top + 3) };
    });
    assert.deepEqual(start, { x: VIEWPORT.width * 0.5, y: Math.round(VIEWPORT.height * 0.45) }, 'the glide starts where the pointer is drawn');
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    assert.deepEqual(await pointerIn(page), { x: 100, y: 120 }, 'the glide ends at its target');

    await page.goto(`${site.baseUrl}/next.html`);
    assert.equal(await pointerIn(page), null, 'the page loaded after the glide holds no pointer');
    await glideTo(page, 300, 200);
    assert.deepEqual(await pointerIn(page), { x: 300, y: 200 });
  } finally {
    await page.close();
    await site.close();
  }
});

test("a page holding an iframe from its own host and one from another shows one pointer, in its top frame, and neither iframe holds a pointer or the pointer's API", { skip }, async () => {
  const site = await serveSite({
    'index.html': '<!doctype html><body><iframe src="/inner.html"></iframe><iframe src="http://other.test/inner.html"></iframe></body>',
    'inner.html': '<!doctype html><body>Inner</body>',
  });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    await page.route('http://other.test/inner.html', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><body>Other</body>' }));
    await installPointer(page);
    await page.goto(`${site.baseUrl}/`);
    await glideTo(page, 100, 120);
    assert.deepEqual(await pointerIn(page), { x: 100, y: 120 });
    const children = page.frames().filter((f) => f !== page.mainFrame());
    assert.deepEqual(children.map((f) => new URL(f.url()).origin).sort(), [new URL(site.baseUrl).origin, 'http://other.test'].sort());
    for (const frame of children) {
      const held = await frame.evaluate(() => ({ pointer: document.getElementById('__ss_pointer__') !== null, api: '__ss' in window }));
      assert.deepEqual(held, { pointer: false, api: false }, `the iframe at ${frame.url()}`);
    }
  } finally {
    await page.close();
    await site.close();
  }
});
