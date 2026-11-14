// Tests for the engine's side of Appium (src/appium.ts), against stand-ins: the WebDriver
// client against a server that answers as Appium does (appium-stand-in.ts), the MJPEG
// reader against a server that streams parts as WebDriverAgent does, split across writes
// at every place a part can be split, and the install of Appium's home against an npm that
// writes the packages it is asked for. test/ios-live.test.ts runs the real Appium.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AppiumSession, WebDriverError, appiumHome, freePorts, moveIntoPlace, provisionAppium, readMjpeg } from '../src/appium.ts';
import { standInAppium } from './appium-stand-in.ts';

const PNG = Buffer.from('a stand-in screenshot');

test('the WebDriver client starts a session, finds elements by accessibility id, reads one that is not there as none, and sends taps and text', async () => {
  const appium = await standInAppium({ frame: () => Buffer.from('frame'), screenshot: PNG });
  try {
    const session = await AppiumSession.start(appium.url, { platformName: 'iOS' }, 5000);
    assert.equal(session.id, 's1');
    assert.deepEqual(appium.commands[0], 'POST /session {"capabilities":{"alwaysMatch":{"platformName":"iOS"},"firstMatch":[{}]}}');
    assert.equal(await session.find('add'), 'add');
    assert.equal(await session.find('empty-hint'), 'empty-hint');
    assert.equal(await session.find('a name nothing has'), null);
    assert.deepEqual(await session.findAll('task'), []);
    await session.type('new-task', 'Ship it');
    await session.click('add');
    assert.deepEqual(await session.findAll('task'), ['task-0']);
    assert.equal(await session.attribute('task-0', 'label'), 'Ship it');
    assert.equal(await session.attribute('task-0', 'value'), 'to do');
    assert.equal(await session.find('empty-hint'), null);
    assert.deepEqual(await session.rect('add'), { x: 310, y: 120, width: 74, height: 44 });
    assert.deepEqual(await session.screenshot(), PNG);
    await session.keys('Write it\n');
    assert.deepEqual(appium.board.tasks.map((t) => t.title), ['Ship it', 'Write it']);
    assert.equal(appium.commands.at(-1), 'POST /keys {"value":["W","r","i","t","e"," ","i","t","\\n"]}');
    await session.execute('mobile: scrollToElement', { elementId: 'summary' });
    assert.equal(appium.commands.at(-1), 'POST /execute/sync {"script":"mobile: scrollToElement","args":[{"elementId":"summary"}]}');
    await session.end();
    assert.equal(appium.commands.at(-1), 'DELETE ');
  } finally {
    await appium.close();
  }
});

test('an error a command is answered with is a WebDriverError carrying its W3C code and the first line of its message', async () => {
  const appium = await standInAppium({ frame: () => Buffer.from('frame'), screenshot: PNG });
  try {
    const session = await AppiumSession.start(appium.url, {}, 5000);
    await assert.rejects(session.click('task-9'), (e: unknown) => e instanceof WebDriverError && e.code === 'stale element reference' && e.message === 'The element is gone');
    await assert.rejects(session.settings({}).then(() => session.attribute('nowhere', 'x')), (e: unknown) => e instanceof WebDriverError && e.code === 'stale element reference');
    await assert.rejects(AppiumSession.start('http://127.0.0.1:9', {}, 2000), /fetch failed|ECONNREFUSED/);
  } finally {
    await appium.close();
  }
});

test('the MJPEG reader hands over each JPEG whole, however the stream splits its parts, and says when the stream ends', async () => {
  const frames = [Buffer.from('\xff\xd8first frame\r\n\r\nwith a blank line inside\xff\xd9', 'latin1'), Buffer.from('second'), Buffer.alloc(3000, 7)];
  const stream = Buffer.concat([
    Buffer.from('\r\n'),
    ...frames.flatMap((f) => [Buffer.from(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${f.length}\r\n\r\n`), f, Buffer.from('\r\n\r\n')]),
  ]);
  const server = createServer(async (_req, res) => {
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
    // Every write a different length, from one byte to seven, so parts split everywhere.
    for (let i = 0, n = 1; i < stream.length; i += n, n = (n % 7) + 1) {
      res.write(stream.subarray(i, i + n));
      await new Promise((r) => setImmediate(r));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const got: Buffer[] = [];
    const ended = await new Promise<Error | undefined>((resolve) => {
      readMjpeg(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`, (jpeg) => got.push(jpeg), resolve);
    });
    assert.equal(ended, undefined);
    assert.deepEqual(got, frames);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('a frame stream that answers with an error ends with its status, and one that is closed hands over nothing more', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/missing') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
    const timer = setInterval(() => res.write('--BoundaryString\r\nContent-Length: 4\r\n\r\nJPEG\r\n\r\n'), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const error = await new Promise<Error | undefined>((resolve) => readMjpeg(`${base}/missing`, () => {}, resolve));
    assert.match(String(error?.message), /the frame stream answered 404/);
    let count = 0;
    let ended = false;
    const stream = readMjpeg(`${base}/`, () => count++, () => (ended = true));
    while (count < 3) await new Promise((r) => setTimeout(r, 10));
    stream.close();
    const at = count;
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(count <= at + 1, `${count - at} frames arrived after the stream was closed`);
    assert.equal(ended, false, 'a stream the engine closed is not reported as ended');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Run `body` with a home of its own and a stand-in npm first on PATH, which records each
 * call (its arguments, the package.json it was run beside, and the engine's keys it was
 * given) and writes the packages that package.json names, or, given `fail`, writes one and
 * exits 1. The engine's keys are set, so a key that reached npm shows. Resolves with the
 * recorded calls.
 */
async function withStandInNpm(fail: boolean, body: (home: string) => Promise<void>): Promise<string[]> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-appium-'));
  const bin = path.join(dir, 'bin');
  const calls = path.join(dir, 'npm-calls');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'npm'),
    '#!/bin/sh\n' +
      `printf '%s | %s | %s %s\\n' "$*" "$(tr -d ' \\n' < package.json)" "\${OPENAI_API_KEY:-no OpenAI key}" "\${VERCEL_AUTOMATION_BYPASS_SECRET:-no bypass key}" >> '${calls}'\n` +
      (fail
        ? "mkdir -p node_modules/appium && echo '{}' > node_modules/appium/package.json && exit 1\n"
        : "for p in appium appium-xcuitest-driver; do mkdir -p node_modules/$p && echo '{}' > node_modules/$p/package.json; done\n"),
    { mode: 0o755 },
  );
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY, VERCEL_AUTOMATION_BYPASS_SECRET: process.env.VERCEL_AUTOMATION_BYPASS_SECRET };
  Object.assign(process.env, { HOME: path.join(dir, 'home'), PATH: `${bin}${path.delimiter}${process.env.PATH}`, OPENAI_API_KEY: 'sk-engine', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-engine' });
  try {
    await body(path.join(dir, 'home'));
    return readFileSync(calls, 'utf8').trim().split('\n');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const NOT_INSTALLED = /^Error: appium: Appium 3\.9\.0 and its XCUITest driver 12\.22\.8 are not installed; install them once with `npx sprintshow provision appium`, or with `npm run provision:appium` in a checkout of sprintshow$/;

test('provision installs the pinned Appium and XCUITest driver into Appium\'s home with npm, once, and with no key', async () => {
  const calls = await withStandInNpm(false, async (home) => {
    assert.throws(() => appiumHome(), NOT_INSTALLED);
    const logs: string[] = [];
    const installed = await provisionAppium((m) => logs.push(m));
    assert.equal(installed, path.join(home, 'Library', 'Caches', 'sprintshow', 'appium', '3.9.0-xcuitest-12.22.8'));
    assert.equal(appiumHome(), installed);
    assert.deepEqual(readdirSync(path.dirname(installed)), [path.basename(installed)], 'nothing of the install is left beside the home');
    assert.equal(await provisionAppium((m) => logs.push(m)), installed);
    assert.equal(logs.at(-1), `appium: Appium 3.9.0 and its XCUITest driver 12.22.8 are installed: ${installed}`);
  });
  assert.deepEqual(calls, ['install --no-audit --no-fund | {"private":true,"dependencies":{"appium":"3.9.0","appium-xcuitest-driver":"12.22.8"}} | no OpenAI key no bypass key'], 'npm ran once');
});

test('an install npm fails leaves no home, and a run still names the command', async () => {
  const calls = await withStandInNpm(true, async (home) => {
    await assert.rejects(provisionAppium(() => {}), /^Error: appium: npm exited 1 installing Appium 3\.9\.0 and its XCUITest driver 12\.22\.8$/);
    assert.deepEqual(readdirSync(path.join(home, 'Library', 'Caches', 'sprintshow', 'appium')), [], 'no home and no install directory');
    assert.throws(() => appiumHome(), NOT_INSTALLED);
  });
  assert.equal(calls.length, 1);
});

test('of two provisions that run at once, the first to finish makes the home, and the other leaves it as it is', async () => {
  const calls = await withStandInNpm(false, async (home) => {
    const logs: string[][] = [[], []];
    const homes = await Promise.all(logs.map((log) => provisionAppium((m) => log.push(m))));
    const installed = path.join(home, 'Library', 'Caches', 'sprintshow', 'appium', '3.9.0-xcuitest-12.22.8');
    assert.deepEqual(homes, [installed, installed]);
    assert.deepEqual(logs.map((log) => log.at(-1)).sort(), [`appium: Appium 3.9.0 and its XCUITest driver 12.22.8 are installed: ${installed}`, `appium: installed ${installed}`]);
    assert.deepEqual(readdirSync(path.dirname(installed)), [path.basename(installed)], 'nothing of either install is left beside the home');
  });
  assert.equal(calls.length, 2, 'npm ran for each');
});

test('a directory moves into place unless one that is whole is there already, and one that is not whole is replaced', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-place-'));
  try {
    const whole = (d: string): boolean => existsSync(path.join(d, 'whole'));
    const made = (name: string): string => {
      mkdirSync(path.join(dir, name));
      writeFileSync(path.join(dir, name, 'whole'), name);
      return path.join(dir, name);
    };
    const home = path.join(dir, 'home');
    assert.equal(moveIntoPlace(made('first'), home, whole), true);
    const second = made('second');
    assert.equal(moveIntoPlace(second, home, whole), false);
    assert.equal(readFileSync(path.join(home, 'whole'), 'utf8'), 'first', 'the whole one in place is kept');
    assert.ok(existsSync(second), 'the one not moved is left to its caller');
    rmSync(path.join(home, 'whole'));
    writeFileSync(path.join(home, 'part'), '');
    assert.equal(moveIntoPlace(second, home, whole), true);
    assert.deepEqual(readdirSync(home), ['whole'], 'the one in place that was not whole is replaced');
    assert.equal(readFileSync(path.join(home, 'whole'), 'utf8'), 'second');
    assert.deepEqual(readdirSync(dir), ['home']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('free ports are as many as asked for, each a different one, and none is held once they resolve', async () => {
  const ports = await freePorts(8);
  assert.equal(new Set(ports).size, 8, String(ports));
  for (const port of ports) {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
