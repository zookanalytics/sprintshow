// Tests for the iOS app surface (src/ios.ts), shown in Chromium against a stand-in for
// Appium and the app it drives (appium-stand-in.ts), so they need no simulator. They pin
// what the step runner sends the app for each action, how each proof reads the app's
// elements, that the page draws the frames of the device's screen, and settles on one
// taken after a step, that settling fails once the frames stop reaching the page, that a
// step's still is the device's own screenshot, and where a tap's touch lands in the page.
// test/ios-live.test.ts drives a real app on a simulator.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript } from '../src/demo-script.ts';
import { AppiumSession } from '../src/appium.ts';
import { showIosApp, hasIosApp, runIosAction, type IosConnection } from '../src/ios.ts';
import { runStep, VIEWPORT } from '../src/browser.ts';
import { standInAppium, type Board, type StandIn } from './appium-stand-in.ts';
import { launchBrowser, scratchDir } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const quiet = (): void => {};
const PNG = Buffer.from('the device screenshot');

/** A JPEG of the whole screen in one colour, made by the browser. */
async function solid(color: string): Promise<Buffer> {
  const page = await browser!.newPage({ viewport: { width: 200, height: 400 } });
  try {
    await page.setContent(`<body style="margin:0;background:${color}"></body>`);
    return await page.screenshot({ type: 'jpeg', quality: 90 });
  } finally {
    await page.close();
  }
}

/** The screen shows red while the board has no task, and green once it has one, or what `withTask` gives in place of green. */
async function board(withTask?: Buffer): Promise<{ appium: StandIn; conn: IosConnection }> {
  const [red, green] = await Promise.all([solid('#e00000'), solid('#00c000')]);
  const appium = await standInAppium({ frame: (b: Board) => (b.tasks.length ? (withTask ?? green) : red), screenshot: PNG });
  const session = await AppiumSession.start(appium.url, {}, 5000);
  const udid = '265F099F-E558-4E32-82BE-F70A75EC0716';
  return {
    appium,
    conn: { app: { udid, bundleId: 'com.example.Board' }, device: `Stand-in (${udid})`, session, screen: appium.screen, frames: appium.frames, close: async () => {} },
  };
}

/** The colour at the centre of the device page's screen, as the page drew it. */
async function screenCentre(page: Page): Promise<string> {
  const [r, g, b] = await page.evaluate(() => {
    const c = document.getElementById('ss-screen') as HTMLCanvasElement;
    return [...(c.getContext('2d') as CanvasRenderingContext2D).getImageData(c.width / 2, c.height / 2, 1, 1).data];
  });
  return r > 150 && g < 80 ? 'red' : g > 150 && r < 80 ? 'green' : `rgb(${r},${g},${b})`;
}

const SCRIPT = parseDemoScript(`# Demo: Stand-in board

**Platform:** iOS

## Steps

1. **The board boots empty**
   \`waitFor new-task\`
   _Prove:_ the hint shows — \`visible empty-hint\`
   _Fail if:_ a task exists — \`count task >= 1\`

2. **Add a task**
   \`type new-task ~ Ship the demo engine\`
   \`click add\`
   _Prove:_ one task — \`count task == 1\`
   _Fail if:_ the hint still shows — \`visible empty-hint\`

3. **Add another with the Return key**
   \`type new-task ~ Write the README\`
   \`press Enter\`
   \`scroll summary\`
   _Prove:_ the summary counts two — \`text summary ~ /^2 tasks · 0 done$/\`

4. **Mark the first done**
   \`click task\`
   _Prove:_ the hint stays hidden — \`hidden empty-hint\`
   _Fail if:_ the first task's value still reads to do — \`text task ~ "to do"\`
`);

test('a step\'s actions reach the app as taps, typing and keys, its proof reads the app\'s elements, and the page settles on a frame taken after it', { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: SCRIPT.title, log: quiet });
    assert.ok(hasIosApp(page));
    assert.equal(await screenCentre(page), 'red', 'the page draws the empty board');
    const lines: string[] = [];
    const proofs = [];
    for (const step of SCRIPT.steps) {
      const at = appium.commands.length;
      proofs.push((await runStep(page, '', step, SCRIPT.steps.length, false, (m) => lines.push(m))).proved);
      const sent = appium.commands.slice(at).filter((c) => !/^(GET|POST) \/element(s)? |\/attribute\/|\/displayed$/.test(c) && !/^POST \/elements? \{/.test(c));
      if (step.index === 2) {
        assert.deepEqual(sent, ['POST /element/new-task/click {}', 'POST /element/new-task/clear {}', 'POST /element/new-task/value {"text":"Ship the demo engine"}', 'POST /element/add/click {}']);
        await surface.settle();
        assert.equal(await screenCentre(page), 'green', 'once settled, the page shows a frame taken after the tap');
      }
      if (step.index === 3) {
        assert.ok(sent.includes('POST /keys {"value":["\\n"]}'), 'Enter is typed as a Return');
        assert.ok(sent.includes('POST /execute/sync {"script":"mobile: scrollToElement","args":[{"elementId":"summary"}]}'));
      }
      if (step.index === 4) assert.deepEqual(sent, ['POST /element/task-0/click {}']);
    }
    assert.deepEqual(proofs, [true, true, true, true], lines.join('\n'));
    assert.deepEqual(appium.board.tasks, [
      { title: 'Ship the demo engine', done: true },
      { title: 'Write the README', done: false },
    ]);
    await surface.close();
    assert.equal(hasIosApp(page), false);
  } finally {
    await page.close();
    await appium.close();
  }
});

test('a proof that the app does not bear fails, and a press with a key an iOS app has none of is logged and sends none of its keys', { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet });
    const step = parseDemoScript(`# Demo: x\n\n**Platform:** iOS\n\n## Steps\n\n1. **Escape is not a key of the app**\n   \`press "a" Enter Escape\`\n   _Prove:_ a task — \`count task >= 1\`\n`).steps[0];
    const lines: string[] = [];
    const at = appium.commands.length;
    const started = Date.now();
    const proof = await runStep(page, '', step, 1, false, (m) => lines.push(m));
    assert.equal(proof.proved, false);
    assert.match(lines.join('\n'), /action `press "a" Enter Escape` did not settle: an iOS app takes Enter, Tab, Backspace, Space or a "quoted string", not Escape/);
    assert.match(proof.reason, /_Prove:_ did not hold: `count task >= 1`/);
    assert.ok(!appium.commands.slice(at).some((c) => c.startsWith('POST /keys')));
    assert.ok(Date.now() - started >= 9000, 'the proof was polled for its time');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

const DEVICE = /Stand-in \(265F099F-E558-4E32-82BE-F70A75EC0716\)'s screen stopped reaching the page: /;

test("once the screen's frames stop, the next settle fails, though the app goes on answering and the step's proof holds", { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const lines: string[] = [];
    const surface = await showIosApp(page, conn, { title: 'x', log: (m) => lines.push(m) });
    assert.equal(await screenCentre(page), 'red');
    appium.endFrames();
    const proof = await runStep(page, '', SCRIPT.steps[1], SCRIPT.steps.length, false, quiet);
    assert.equal(proof.proved, true, 'the app took the task');
    await assert.rejects(surface.settle(), new RegExp(DEVICE.source + 'the stream ended$'));
    assert.equal(await screenCentre(page), 'red', 'the page still shows the board as it was before the task');
    assert.match(lines.join('\n'), new RegExp(DEVICE.source + 'the stream ended'), 'the log says when the frames stopped');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

test('a stream of the screen that stays open but sends no frame fails the settle once the frame wait has passed', { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet, frameWait: 1500 });
    appium.holdFrames();
    const started = Date.now();
    await assert.rejects(surface.settle(), new RegExp(DEVICE.source + 'no frame taken after the step came within 1\\.5s$'));
    assert.ok(Date.now() - started >= 1500, 'it waited the frame wait for a frame');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

test('a frame the page cannot draw stops the screen reaching the page, and the next settle fails', { skip }, async () => {
  const { appium, conn } = await board(Buffer.from('not a JPEG'));
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet });
    await runStep(page, '', SCRIPT.steps[1], SCRIPT.steps.length, false, quiet);
    await assert.rejects(surface.settle(), new RegExp(DEVICE.source + 'the page could not draw a frame: '));
    assert.equal(await screenCentre(page), 'red');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

test("a step's still is the device's own screenshot, and a tap's touch lands on the element's centre, mapped from the screen's points into the page", { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  const { dir, cleanup } = scratchDir();
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet });
    const file = path.join(dir, 'still.png');
    await surface.still?.(file);
    assert.deepEqual(readFileSync(file), PNG);

    // The screen is fitted to the 1280x900 frame less a 24-pixel margin and the 72-pixel
    // caption band: 780 pixels tall, so a point is 780/800 of a pixel, centred across.
    const box = await page.evaluate(() => (document.getElementById('ss-screen') as HTMLElement).getBoundingClientRect().toJSON());
    assert.deepEqual([box.width, box.height, box.y], [390, 780, 24]);
    assert.equal(box.x, (1280 - 390) / 2);
    const touches: number[][] = [];
    const add = parseDemoScript(`# Demo: x\n\n**Platform:** iOS\n\n## Steps\n\n1. **Tap Add**\n   \`click add\`\n`).steps[0].actions[0];
    await runIosAction(page, add, { timeout: 1000, keyPause: 0, pause: 0, touch: async (x, y) => void touches.push([x, y]) });
    // Add lies at x 310-384 and y 120-164 points: its centre is (347, 142).
    assert.deepEqual(touches, [[box.x + 347 * 0.975, box.y + 142 * 0.975]]);
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
    cleanup();
  }
});
