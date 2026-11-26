// Tests for the iOS app surface (src/ios.ts), shown in Chromium against a stand-in for
// Appium and the app it drives (appium-stand-in.ts), so they need no simulator. They pin
// what the step runner sends the app for each action, and how each proof reads the app's
// elements. They pin that a page captured once each step has settled shows the device's
// screenshot taken after the step, whatever the frames of its screen show, and fails the
// settle when one cannot be taken. They pin that a recorded page draws the frames of the
// device's screen, settles on one that came after a step, and fails the settle once the
// frames stop reaching it. And they pin that a step's still is the device's own
// screenshot, and where a tap's touch lands in the page. Also, which servers the ports a
// caller names are for, and that a named port something already answers on is refused
// before the device is looked at. test/ios-live.test.ts drives a real app on a simulator.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript } from '../src/demo-script.ts';
import { AppiumSession, freePorts } from '../src/appium.ts';
import { connectIosApp, iosPorts, showIosApp, hasIosApp, runIosAction, type IosConnection } from '../src/ios.ts';
import { runStep, VIEWPORT } from '../src/browser.ts';
import { standInAppium, type Board, type StandIn } from './appium-stand-in.ts';
import { launchBrowser, scratchDir } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const quiet = (): void => {};

test("the ports a caller names are Appium's server's, WebDriverAgent's and its stream of the screen's frames', in that order, and none leaves each to the system", () => {
  assert.deepEqual(iosPorts([4723, 8100, 9100]), { appium: 4723, agent: 8100, frames: 9100 });
  assert.equal(iosPorts(undefined), null);
});

test('a named port something already answers on is refused before the device is looked at', async () => {
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const { port } = blocker.address() as AddressInfo;
  // No device has this UDID, so a check that came after the device's would fail on it.
  const url = 'ios-simulator://00000000-0000-0000-0000-000000000000/com.example.Board';
  try {
    const [appium, frames] = await freePorts(2);
    await assert.rejects(connectIosApp(url, quiet, [appium, port, frames]), {
      message: `ios: something already answers on port ${port}, which --port names for WebDriverAgent's server; name a port nothing listens on`,
    });
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

/** The whole screen in one colour, as a frame of the stream, a JPEG, and as a screenshot, a PNG, made by the browser. */
async function solid(color: string): Promise<{ jpeg: Buffer; png: Buffer }> {
  const page = await browser!.newPage({ viewport: { width: 200, height: 400 } });
  try {
    await page.setContent(`<body style="margin:0;background:${color}"></body>`);
    return { jpeg: await page.screenshot({ type: 'jpeg', quality: 90 }), png: await page.screenshot({ type: 'png' }) };
  } finally {
    await page.close();
  }
}

let solids: Promise<{ red: { jpeg: Buffer; png: Buffer }; green: { jpeg: Buffer; png: Buffer } }> | null = null;
/** The board's screen: red while it has no task, and green once it has one. */
const screens = (): NonNullable<typeof solids> => (solids ??= Promise.all([solid('#e00000'), solid('#00c000')]).then(([red, green]) => ({ red, green })));

/**
 * A stand-in for the board, whose frames and screenshots show its screen as it is, unless
 * `frame` or `screenshot` gives what they show for the board in its place.
 */
async function board(o: { frame?: (b: Board) => Buffer; screenshot?: (b: Board) => Buffer | null } = {}): Promise<{ appium: StandIn; conn: IosConnection }> {
  const { red, green } = await screens();
  const appium = await standInAppium({ frame: o.frame ?? ((b) => (b.tasks.length ? green : red).jpeg), screenshot: o.screenshot ?? ((b) => (b.tasks.length ? green : red).png) });
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

test("a step's actions reach the app as taps, typing and keys, its proof reads the app's elements, and a recorded page settles on a frame of the screen that came after it", { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: SCRIPT.title, log: quiet, stream: true });
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

test("a page captured once each step has settled shows the device's screenshot taken after the step, though the frames of its screen show it as it was before", { skip }, async () => {
  const { red, green } = await screens();
  // The frames lag behind the app for good: each shows the board as it was before the step.
  const { appium, conn } = await board({ frame: () => red.jpeg });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  const { dir, cleanup } = scratchDir();
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet });
    assert.equal(await screenCentre(page), 'red', 'the page draws the empty board');
    const proof = await runStep(page, '', SCRIPT.steps[1], SCRIPT.steps.length, false, quiet);
    assert.equal(proof.proved, true, 'the app took the task');
    await surface.settle();
    assert.equal(await screenCentre(page), 'green', 'once settled, the page shows the screenshot taken after the step');
    const file = path.join(dir, 'still.png');
    await surface.still?.(file);
    assert.deepEqual(readFileSync(file), green.png, "the step's still is the screenshot the page shows");
    await surface.close();
    assert.equal(hasIosApp(page), false);
  } finally {
    await page.close();
    await appium.close();
    cleanup();
  }
});

test("a page captured once each step has settled fails the settle when the device's screenshot cannot be taken", { skip }, async () => {
  const { red } = await screens();
  const { appium, conn } = await board({ screenshot: (b) => (b.tasks.length ? null : red.png) });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet });
    await runStep(page, '', SCRIPT.steps[1], SCRIPT.steps.length, false, quiet);
    await assert.rejects(surface.settle(), /^Error: ios: could not take Stand-in \(265F099F-E558-4E32-82BE-F70A75EC0716\)'s screenshot: Unable to take a screenshot$/);
    assert.equal(await screenCentre(page), 'red', 'the page still shows the board as it was before the task');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

const DEVICE = /Stand-in \(265F099F-E558-4E32-82BE-F70A75EC0716\)'s screen stopped reaching the page: /;

test("once the screen's frames stop, a recorded page's next settle fails, though the app goes on answering and the step's proof holds", { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const lines: string[] = [];
    const surface = await showIosApp(page, conn, { title: 'x', log: (m) => lines.push(m), stream: true });
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

test("a stream of the screen that stays open but sends no frame fails a recorded page's settle once the frame wait has passed", { skip }, async () => {
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet, stream: true, frameWait: 1500 });
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

test("a frame the page cannot draw stops the screen reaching a recorded page, and the next settle fails", { skip }, async () => {
  const { red } = await screens();
  const { appium, conn } = await board({ frame: (b) => (b.tasks.length ? Buffer.from('not a JPEG') : red.jpeg) });
  const page = await browser!.newPage({ viewport: VIEWPORT });
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet, stream: true });
    await runStep(page, '', SCRIPT.steps[1], SCRIPT.steps.length, false, quiet);
    await assert.rejects(surface.settle(), new RegExp(DEVICE.source + 'the page could not draw a frame: '));
    assert.equal(await screenCentre(page), 'red');
    await surface.close();
  } finally {
    await page.close();
    await appium.close();
  }
});

test("a recorded page's still is the device's own screenshot, and a tap's touch lands on the element's centre, mapped from the screen's points into the page", { skip }, async () => {
  const { red } = await screens();
  const { appium, conn } = await board();
  const page = await browser!.newPage({ viewport: VIEWPORT });
  const { dir, cleanup } = scratchDir();
  try {
    const surface = await showIosApp(page, conn, { title: 'x', log: quiet, stream: true });
    const file = path.join(dir, 'still.png');
    await surface.still?.(file);
    assert.deepEqual(readFileSync(file), red.png);

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
