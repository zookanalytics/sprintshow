// The iOS app surface. A demo script that declares `**Platform:** iOS` drives an app on an
// iOS Simulator device, the one its simulator URL names (simulator.ts), through Appium's
// XCUITest driver (appium.ts), where a page script drives a page in Chromium.
//
// Connecting comes first, apart from any page, because it takes seconds: a walkthrough
// connects before it starts its recording (connectIosApp). The engine checks that the
// device is booted and has the app, and refuses a device that holds a WebDriverAgent
// runner app another tool installed, which Appium would remove. It dresses the device
// (simulator.ts), starts Appium, and starts a session, which installs the engine's runner
// app (webdriveragent.ts) on the device and launches it. Then it brings the app to the
// front as the app stands: an app that runs keeps its process, its screen and its state,
// and one that does not is launched, with no arguments. The session never ends the app.
//
// Like the terminal, the surface is a page the engine writes into the capture's browser
// page (showIosApp): the device's screen, drawn from the frames WebDriverAgent streams of
// it, on a backdrop above the caption band. So the videos film it as they film a page,
// with the engine's captions and cards, and its pointer shows a touch where a step taps.
// A capture that makes a video settles the surface once each step is done, until a frame
// taken after the step is drawn, and fails once the frames stop reaching the page, so its
// video never shows a screen the app has moved past. A step's PNG is the device's own
// screenshot instead, at the device's scale, with nothing of the engine's on it
// (Surface.still).
//
// A step's actions go to the app through Appium, as gestures and keys, and its proof reads
// the app's elements through Appium. A selector names an element by its accessibility
// identifier, or by its label when it has no identifier, as Appium's `accessibility id`
// strategy matches them. An element's text is its label and its value: a button's label
// is its title and its value its state, and a text field's value is what it holds.
//
// Closing ends the session and Appium, removes the runner app and puts back what the
// engine changed on the device, so the device is left as it was given, its app running.

import { writeFileSync } from 'node:fs';
import type { Page } from 'playwright';

import { compareCount, keysIosLacks, matchText, IOS_KEYS, type Assertion, type DemoAction, type IosKey } from './demo-script.ts';
import { AppiumSession, freePorts, readMjpeg, startAppium, type AppiumServer, type FrameStream } from './appium.ts';
import { checkApp, dressDevice, parseSimulatorUrl, simctl, userApps, SIMULATOR_URL_FORM, type SimulatorApp } from './simulator.ts';
import { runnerApp, RUNNER_APP_ID, RUNNER_BUNDLE_NAME } from './webdriveragent.ts';
import type { Surface } from './browser.ts';

/** How long Appium has to start a session: to install the runner app, launch it and connect. */
const SESSION_START_MS = 180_000;
/** How long Appium keeps a session the engine sends nothing to, so one the engine left behind ends. */
const IDLE_SESSION_S = 600;
/** The frames WebDriverAgent streams: the rate a recording films a page at, at half the screen's pixels, which is more than a video frame shows of it. */
const STREAM = { mjpegServerFramerate: 25, mjpegScalingFactor: 50, mjpegServerScreenshotQuality: 75 };
/** How long after a frame is taken it may reach the engine. A frame that reaches it later than this past a moment was taken after it. */
const FRAME_LAG_MS = 120;
/**
 * How long the page waits for a frame of the screen: the first, or one taken after
 * `settle` began. WebDriverAgent sends a frame at every tick, and backs off for up to ten
 * seconds after a screenshot it fails to take, so a screen with no frame for this long is
 * lost.
 */
const FRAME_WAIT_MS = 30_000;
/** The stage the screen is fitted to: the viewport less a margin all round and the caption bar's band at the bottom, as the terminal's. */
const STAGE = { margin: 24, band: 72 };
/** How often an action polls for its element, and a wait for its condition. */
const POLL_MS = 200;

/** An iOS app the engine is connected to. */
export interface IosConnection {
  app: SimulatorApp;
  /** The device's name. */
  device: string;
  session: AppiumSession;
  /** The screen's size, in points. */
  screen: { width: number; height: number };
  /** The URL of the stream of the screen's frames. */
  frames: string;
  /** End the session and Appium, remove the runner app, and put back what the engine changed on the device. */
  close(): Promise<void>;
}

/** What the engine did to connect, each with what undoes it, in the order it did them. */
type Undo = { what: string; run: () => Promise<unknown> };

/** Run each step of `undo` from the last, logging one that fails and going on. */
async function undoAll(undo: Undo[], log: (m: string) => void): Promise<void> {
  for (const step of undo.splice(0).reverse()) {
    try {
      await step.run();
    } catch (e) {
      log(`ios: could not ${step.what}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

/** Remove the engine's runner app from device `udid`, when the device has it. */
async function removeRunner(udid: string): Promise<void> {
  try {
    await simctl(['get_app_container', udid, RUNNER_APP_ID]);
  } catch {
    return;
  }
  await simctl(['uninstall', udid, RUNNER_APP_ID]);
}

/** The lines of what Appium printed that say why a session did not start. */
function appiumWhy(server: AppiumServer): string {
  const why = server.output().filter((l) => /error|unable|fail/i.test(l)).slice(-2);
  return why.length ? `; Appium logged: ${why.join(' / ')}` : '';
}

/**
 * Connect to the iOS app `baseUrl` names, ready to show in a page: check its device, dress
 * the device, start Appium and a session, and bring the app to the front as it stands.
 * Throws, having put back whatever it did, when the URL names no app, the runner app is
 * not built, the device is not booted, lacks the app or holds another runner app, or
 * Appium does not start a session.
 */
export async function connectIosApp(baseUrl: string | undefined, log: (m: string) => void): Promise<IosConnection> {
  const app = baseUrl ? parseSimulatorUrl(baseUrl) : null;
  if (!app) throw new Error(`an iOS app script drives the app its simulator URL names, ${SIMULATOR_URL_FORM}${baseUrl ? ` (got "${baseUrl}")` : ''}`);
  const runner = await runnerApp();
  const name = await checkApp(app);
  const device = `${name} (${app.udid})`;
  const others = (await userApps(app.udid)).filter((a) => a.name === RUNNER_BUNDLE_NAME && a.bundleId !== RUNNER_APP_ID).map((a) => a.bundleId);
  if (others.length) {
    throw new Error(`simulator: ${device} holds another WebDriverAgent runner app, ${others.join(', ')}, which Appium would remove; remove it, or name a device without one`);
  }

  const undo: Undo[] = [];
  try {
    undo.push({ what: 'put the device back as it was given', run: await dressDevice(app.udid, log) });
    undo.push({ what: 'remove the runner app', run: () => removeRunner(app.udid) });
    const server = await startAppium(log);
    undo.push({ what: 'stop Appium', run: server.stop });
    // WebDriverAgent's two ports differ from each other, and from Appium's, which Appium
    // holds by now. Nothing holds them from here until WebDriverAgent listens on them, so
    // another process can still take one first: the XCUITest driver checks no port on a
    // simulator.
    const [wdaPort, framesPort] = await freePorts(2);
    const capabilities = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:udid': app.udid,
      'appium:bundleId': app.bundleId,
      // The app as it stands: not launched, relaunched, reset or ended by the session.
      'appium:autoLaunch': false,
      'appium:forceAppLaunch': false,
      'appium:shouldTerminateApp': false,
      'appium:noReset': true,
      // The engine's runner app, installed from its build and launched without xcodebuild.
      'appium:usePreinstalledWDA': true,
      'appium:prebuiltWDAPath': runner,
      'appium:wdaLocalPort': wdaPort,
      'appium:mjpegServerPort': framesPort,
      'appium:wdaLaunchTimeout': SESSION_START_MS,
      'appium:wdaConnectionTimeout': SESSION_START_MS,
      'appium:newCommandTimeout': IDLE_SESSION_S,
    };
    log(`ios: starting a session on ${device}…`);
    let session: AppiumSession;
    try {
      session = await AppiumSession.start(server.url, capabilities, SESSION_START_MS);
    } catch (e) {
      throw new Error(`appium: no session on ${device}: ${(e as Error).message.split('\n')[0]}${appiumWhy(server)}`);
    }
    undo.push({ what: 'end the Appium session', run: () => session.end() });
    await session.execute('mobile: activateApp', { bundleId: app.bundleId });
    await session.settings(STREAM);
    const { width, height } = await session.windowRect();
    log(`ios: ${app.bundleId} on ${device} · ${width}x${height} points`);
    return {
      app,
      device,
      session,
      screen: { width, height },
      frames: `http://127.0.0.1:${framesPort}/`,
      close: () => undoAll(undo, log),
    };
  } catch (e) {
    await undoAll(undo, log);
    throw e;
  }
}

/** The device page's API, `window.__ss_device`. */
interface PageDevice {
  /** Draw a JPEG, given in base64, on the screen; resolves once the browser has drawn it. */
  draw(jpeg: string): Promise<void>;
  /** Where the screen is in the page, in CSS pixels. */
  box(): { x: number; y: number; width: number; height: number };
}

type DeviceWindow = { __ss_device: PageDevice };

/** The device page: the screen, fitted to the stage, on the terminal's backdrop. The pointer is drawn as a touch. */
function deviceDocument(title: string, screen: { width: number; height: number }): string {
  const css =
    'html,body{margin:0;height:100%}' +
    `body{box-sizing:border-box;height:100vh;padding:${STAGE.margin}px ${STAGE.margin}px ${STAGE.margin + STAGE.band}px;` +
    'display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 30%,#262b36 0%,#0b0d12 72%)}' +
    '#ss-device{border-radius:18px;overflow:hidden;background:#000;box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.08)}' +
    '#ss-screen{display:block;width:100%;height:100%}' +
    '#__ss_pointer__{width:34px!important;height:34px!important;margin:-17px 0 0 -17px!important;border-radius:50%;filter:none!important;' +
    'background:rgba(255,255,255,.35);box-shadow:0 0 0 2px rgba(255,255,255,.9),0 2px 10px rgba(0,0,0,.45)}' +
    '#__ss_pointer__ svg{display:none}';
  const fit =
    `const W=${screen.width},H=${screen.height};` +
    'const fit=()=>{const cs=getComputedStyle(document.body);' +
    'const w=document.body.clientWidth-parseFloat(cs.paddingLeft)-parseFloat(cs.paddingRight);' +
    'const h=document.body.clientHeight-parseFloat(cs.paddingTop)-parseFloat(cs.paddingBottom);' +
    'const k=Math.min(w/W,h/H);const d=document.getElementById("ss-device");d.style.width=Math.floor(W*k)+"px";d.style.height=Math.floor(H*k)+"px";};' +
    'fit();addEventListener("resize",fit);';
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${css}</style></head>` +
    `<body><div id="ss-device"><canvas id="ss-screen"></canvas></div><script>${fit}</script></body></html>`
  );
}

/** Runs in the page: expose `window.__ss_device`, which draws the frames on the screen's canvas. */
function installDevice(): void {
  const canvas = document.getElementById('ss-screen') as HTMLCanvasElement;
  const api: PageDevice = {
    async draw(jpeg) {
      const bytes = Uint8Array.from(atob(jpeg), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const w = Math.round(canvas.clientWidth * devicePixelRatio);
      const h = Math.round(canvas.clientHeight * devicePixelRatio);
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, w, h);
      bitmap.close();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    },
    box() {
      const r = canvas.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },
  };
  (window as unknown as DeviceWindow).__ss_device = api;
}

/** An iOS app shown in a page. */
interface Shown {
  conn: IosConnection;
}

/** The pages that show an iOS app, each with its connection. */
const shown = new WeakMap<Page, Shown>();

/** Whether `page` shows an iOS app the engine is connected to, so a step's actions and proofs go to the app. */
export function hasIosApp(page: Page): boolean {
  return shown.has(page);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Show the app `conn` connects to in `page`: write the device page, and draw the frames
 * WebDriverAgent streams of the screen as they arrive, the newest each time the page is
 * ready for one. Resolves once the page shows the first frame. The surface's `still` saves
 * the device's own screenshot. Closing it stops the frames; the connection stays open.
 *
 * The screen stops reaching the page when the stream ends or the page cannot draw a
 * frame, and `settle` throws from then on, as it does when no frame taken after it began
 * reaches the page within `frameWait` ms (default FRAME_WAIT_MS). So a capture that
 * settles the surface fails, rather than saving a screen the app has moved past.
 */
export async function showIosApp(page: Page, conn: IosConnection, o: { title: string; log: (m: string) => void; frameWait?: number }): Promise<Surface> {
  const frameWait = o.frameWait ?? FRAME_WAIT_MS;
  await page.setContent(deviceDocument(o.title, conn.screen));
  await page.evaluate(installDevice);

  let latest: { jpeg: Buffer; at: number } | null = null;
  let shownAt = 0;
  let pumping: Promise<void> | null = null;
  let closed = false;
  /** Why the screen stopped reaching the page, once it has. */
  let lost: string | null = null;
  const lose = (why: string): void => {
    if (closed || lost) return;
    lost = why;
    o.log(`ios: ${conn.device}'s screen stopped reaching the page: ${why}`);
  };
  const pump = (): void => {
    if (pumping || closed || lost) return;
    pumping = (async () => {
      while (latest && !closed && !lost) {
        const frame = latest;
        latest = null;
        await page.evaluate((b64) => (window as unknown as DeviceWindow).__ss_device.draw(b64), frame.jpeg.toString('base64'));
        shownAt = frame.at;
      }
    })()
      .catch((e: Error) => {
        // A page that has closed shows nothing any more, which is no loss of the screen.
        if (page.isClosed()) closed = true;
        else lose(`the page could not draw a frame: ${e.message.split('\n')[0]}`);
      })
      .finally(() => {
        pumping = null;
        if (latest) pump();
      });
  };
  const stream: FrameStream = readMjpeg(
    conn.frames,
    (jpeg) => {
      latest = { jpeg, at: Date.now() };
      pump();
    },
    (e) => lose(e?.message ?? 'the stream ended'),
  );
  shown.set(page, { conn });

  const close = async (): Promise<void> => {
    closed = true;
    stream.close();
    shown.delete(page);
    await pumping;
  };
  const deadline = Date.now() + frameWait;
  while (shownAt === 0 && !lost && Date.now() < deadline) await sleep(25);
  if (shownAt === 0) {
    await close();
    throw new Error(`ios: no frame of ${conn.device}'s screen reached the page${lost ? `: ${lost}` : ` within ${frameWait / 1000}s`}`);
  }

  return {
    async settle() {
      // An element query waits for the app to go idle, its animations included, so the
      // next frame taken shows where they end.
      await conn.session.find('__sprintshow_settle__').catch(() => null);
      const since = Date.now() + FRAME_LAG_MS;
      const cap = Date.now() + frameWait;
      while (!closed && !lost && shownAt < since && Date.now() < cap) await sleep(20);
      if (closed || shownAt >= since) return;
      throw new Error(`ios: ${conn.device}'s screen stopped reaching the page: ${lost ?? `no frame taken after the step came within ${frameWait / 1000}s`}`);
    },
    async still(file: string) {
      writeFileSync(file, await conn.session.screenshot());
    },
    close,
  };
}

/** The connection of the app `page` shows. Throws when it shows none. */
function connection(page: Page): IosConnection {
  const s = shown.get(page);
  if (!s) throw new Error('this page shows no iOS app');
  return s.conn;
}

/** Poll `done` until it holds, or throw `why` once `timeout` ms have passed. */
async function until(done: () => Promise<boolean>, timeout: number, why: string): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await done()) return;
    if (Date.now() >= deadline) throw new Error(`${why} within ${timeout / 1000}s`);
    await sleep(POLL_MS);
  }
}

/** The first element `selector` names, once there is one. Throws when none comes within `timeout` ms. */
async function element(session: AppiumSession, selector: string, timeout: number): Promise<string> {
  let found: string | null = null;
  await until(async () => (found = await session.find(selector)) !== null, timeout, `no element named \`${selector}\``);
  return found as unknown as string;
}

/** An element's text: its label and its value, those it has. */
async function texts(session: AppiumSession, el: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of ['label', 'value']) {
    const t = await session.attribute(el, name);
    if (t) out.push(t);
  }
  return out;
}

/** The character each key a `press` presses in an iOS app types into the field that has the keyboard's focus. */
const KEY_TEXT: Record<IosKey, string> = { Enter: '\n', Tab: '\t', Backspace: '\b', Space: ' ' };

/** How an iOS app's actions are paced and shown. */
export interface IosPace {
  /** How long an action waits for its element, or for what it waits for. */
  timeout: number;
  /** A pause between the keys a `press` presses, so a recording shows each one land. */
  keyPause: number;
  /** A pause once a `press` is done, so its effect reads in a recording. */
  pause: number;
  /** Show a touch at a point of the page before a tap, in humanized driving; null when driving direct. */
  touch: ((x: number, y: number) => Promise<void>) | null;
}

/** Show a touch at the centre of `el`, mapped from the screen's points into the page. */
async function touch(page: Page, conn: IosConnection, el: string, pace: IosPace): Promise<void> {
  if (!pace.touch) return;
  const [rect, box] = await Promise.all([conn.session.rect(el), page.evaluate(() => (window as unknown as DeviceWindow).__ss_device.box())]);
  const k = box.width / conn.screen.width;
  await pace.touch(box.x + (rect.x + rect.width / 2) * k, box.y + (rect.y + rect.height / 2) * k);
}

/**
 * Run one action of an iOS app script on the app `page` shows: `click` taps the element,
 * `type` taps the field, clears it and types the text, `scroll` scrolls until the element
 * shows, `press` types each key into the field with the keyboard's focus, `waitFor` and
 * `waitForText` wait on the element, and `wait` pauses. Throws when it does not settle.
 */
export async function runIosAction(page: Page, act: DemoAction, pace: IosPace): Promise<void> {
  const conn = connection(page);
  const { session } = conn;
  switch (act.verb) {
    case 'wait':
      await page.waitForTimeout(act.ms ?? 0);
      return;
    case 'waitFor':
      await until(async () => {
        const el = await session.find(act.target);
        return el !== null && (await session.displayed(el));
      }, pace.timeout, `no element named \`${act.target}\` showed`);
      return;
    case 'waitForText':
      await until(async () => {
        const el = await session.find(act.target);
        return el !== null && (await texts(session, el)).some((t) => t.includes(act.text ?? ''));
      }, pace.timeout, `\`${act.target}\` did not read "${act.text ?? ''}"`);
      return;
    case 'click': {
      const el = await element(session, act.target, pace.timeout);
      await touch(page, conn, el, pace);
      await session.click(el);
      return;
    }
    case 'type': {
      const el = await element(session, act.target, pace.timeout);
      await touch(page, conn, el, pace);
      await session.click(el);
      await session.clear(el);
      await session.type(el, act.text ?? '');
      return;
    }
    case 'scroll': {
      const el = await element(session, act.target, pace.timeout);
      await session.execute('mobile: scrollToElement', { elementId: el });
      return;
    }
    case 'press': {
      const keys = act.keys ?? [];
      // A press with a key the app has none of presses none of its keys.
      const lacked = keysIosLacks(keys);
      if (lacked.length) throw new Error(`an iOS app takes ${IOS_KEYS.join(', ')} or a "quoted string", not ${lacked.join(', ')}`);
      for (const [i, k] of keys.entries()) {
        await session.keys('text' in k ? k.text : KEY_TEXT[k.key as IosKey]);
        const pause = i + 1 < keys.length ? pace.keyPause : pace.pause;
        if (pause > 0) await page.waitForTimeout(pause);
      }
      return;
    }
    default:
      throw new Error(`\`${act.verb}\` is not an action of an iOS app script`);
  }
}

/**
 * Check an iOS app script's assertion once, against the app `page` shows: `visible` holds
 * when the first element the selector names is displayed, `hidden` when none is, `count`
 * on how many it names, and `text` when the first one's label or value matches.
 */
export async function checkIosAssertion(page: Page, a: Assertion): Promise<boolean> {
  const { session } = connection(page);
  const selector = a.selector ?? '';
  switch (a.kind) {
    case 'visible': {
      const el = await session.find(selector);
      return el !== null && (await session.displayed(el));
    }
    case 'hidden': {
      for (const el of await session.findAll(selector)) if (await session.displayed(el)) return false;
      return true;
    }
    case 'count':
      return compareCount((await session.findAll(selector)).length, a.op ?? '', a.n ?? 0);
    case 'text': {
      const el = await session.find(selector);
      return el !== null && (await texts(session, el)).some((t) => matchText(t, a.matcher));
    }
    default:
      return false;
  }
}
