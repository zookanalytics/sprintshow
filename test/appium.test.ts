// Tests for the engine's side of Appium (src/appium.ts), against stand-ins: the WebDriver
// client against a server that answers as Appium does (appium-stand-in.ts), and the
// MJPEG reader against a server that streams parts as WebDriverAgent does, split across
// writes at every place a part can be split. test/ios-live.test.ts runs the real Appium.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { AppiumSession, WebDriverError, readMjpeg } from '../src/appium.ts';
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
