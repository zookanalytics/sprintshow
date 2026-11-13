// Tests for the server seam (src/server.ts): the built-in static server behind
// `--serve-dir`, and how an iOS app script's app is named or brought up.
//
// With no port named it listens on one the system assigns, so two captures on one host
// each get a server of their own. A named port that is taken fails the start with an
// error the caller can report, and a port no server can listen on is refused before
// anything is served or spawned.
//
// An iOS app's `--serve` command is a stand-in here, a node script that prints what a
// start command prints: the app's simulator URL on a line of its standard output once the
// app is up. test/ios-live.test.ts runs the sample's real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureServer, ensureIosApp } from '../src/server.ts';

const quiet = (): void => {};

/** Run `fn` with a scratch directory holding one index.html, always cleaned up. */
async function withSite(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-test-'));
  writeFileSync(path.join(dir, 'index.html'), '<p>hello</p>');
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('serve-dir with no port listens on a free port, and two side by side each get their own', async () => {
  await withSite(async (dir) => {
    const a = await ensureServer({ serveDir: dir, log: quiet });
    const b = await ensureServer({ serveDir: dir, log: quiet });
    try {
      assert.notEqual(a.baseUrl, b.baseUrl);
      for (const s of [a, b]) {
        assert.match(s.baseUrl, /^http:\/\/localhost:\d+$/);
        const res = await fetch(`${s.baseUrl}/`);
        assert.equal(res.status, 200);
        assert.equal(await res.text(), '<p>hello</p>');
      }
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});

test('serve-dir on a named port serves on that port', async () => {
  await withSite(async (dir) => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const s = await ensureServer({ serveDir: dir, port, log: quiet });
    try {
      assert.equal(s.baseUrl, `http://localhost:${port}`);
      assert.equal(await (await fetch(`${s.baseUrl}/`)).text(), '<p>hello</p>');
    } finally {
      await s.stop();
    }
  });
});

test('a port that is not a whole number from 1 to 65535 is refused before anything is served or spawned', async () => {
  await withSite(async (dir) => {
    const marker = path.join(dir, 'spawned');
    for (const port of [Number.NaN, 0, -1, 80.5, 65536]) {
      const message = `server: the port must be a whole number from 1 to 65535 (got ${port})`;
      await assert.rejects(ensureServer({ serveDir: dir, port, log: quiet }), { message });
      await assert.rejects(ensureServer({ serve: `touch ${JSON.stringify(marker)}`, port, log: quiet }), { message });
    }
    assert.equal(existsSync(marker), false, 'no serve command was spawned');
  });
});

test('serve-dir on a named port that is taken rejects the start', async () => {
  await withSite(async (dir) => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    const port = (blocker.address() as AddressInfo).port;
    try {
      await assert.rejects(ensureServer({ serveDir: dir, port, log: quiet }), /server: cannot serve .*EADDRINUSE/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

const UDID = '265F099F-E558-4E32-82BE-F70A75EC0716';
const APP_URL = `ios-simulator://${UDID}/com.example.Board`;

/**
 * A stand-in start command. It records what its environment holds, and then its process
 * once it handles SIGTERM. It prints its progress, and then the app's URL unless told to
 * fail or stay silent. Told to stop, it records that it stopped and exits, a second later
 * when its stopping is slow, and never when it is deaf to SIGTERM.
 */
const STAND_IN = `import { writeFileSync } from 'node:fs';
const [record, mode, stopping] = process.argv.slice(2);
process.on('SIGTERM', () => {
  if (stopping === 'deaf') return;
  setTimeout(() => { writeFileSync(record + '.stopped', ''); process.exit(0); }, stopping === 'slow' ? 1000 : 0);
});
writeFileSync(record + '.env', JSON.stringify({ bypass: 'VERCEL_AUTOMATION_BYPASS_SECRET' in process.env, speech: 'OPENAI_API_KEY' in process.env, path: Boolean(process.env.PATH) }));
writeFileSync(record + '.pid', String(process.pid));
console.error('building the app');
console.log('booting a device; the URL comes once the app is up');
if (mode === 'fail') { console.error('xcodebuild exited 65'); process.exit(65); }
if (mode === 'ready') setTimeout(() => console.log('ready: ${APP_URL}'), 300);
setInterval(() => {}, 1 << 30);
`;

/** Run `fn` with the stand-in start command written to a scratch directory, and the path its records go to. */
async function withStandIn(fn: (dir: string, record: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-test-'));
  writeFileSync(path.join(dir, 'start.mjs'), STAND_IN);
  const record = path.join(dir, 'record');
  try {
    await fn(dir, record);
  } finally {
    // A stand-in that a failing test leaves running would hold the engine's pipes open, and
    // the test file with them. One deaf to SIGTERM ends only when it is killed.
    try {
      const pid = Number(readFileSync(`${record}.pid`, 'utf8'));
      if (Number.isInteger(pid) && pid > 1) process.kill(pid, 'SIGKILL');
    } catch {
      /* none was started, or it has ended */
    }
    // A stand-in can still be writing a record as it is killed, so the directory can take a
    // moment to stay empty.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  }
}

/** Resolve once `file` exists, or fail after `ms`. */
async function appears(file: string, ms = 10000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > deadline) assert.fail(`${file} did not appear within ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Resolve once process `pid` has ended, or fail after `ms`. */
async function ended(pid: number, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    if (Date.now() > deadline) assert.fail(`process ${pid} still ran ${ms / 1000}s on`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("an iOS app already running is named by its simulator URL as --base-url, and nothing is started or stopped", async () => {
  const app = await ensureIosApp({ baseUrl: APP_URL.replace(UDID, UDID.toLowerCase()) + '/', log: quiet });
  assert.equal(app.baseUrl, APP_URL);
  await app.stop();
  await assert.rejects(ensureIosApp({ baseUrl: 'http://localhost:3000', log: quiet }), /an iOS app script takes its app's simulator URL, ios-simulator:\/\/<device UDID>\/<bundle id>, as --base-url \(got "http:\/\/localhost:3000"\)/);
  await assert.rejects(ensureIosApp({ log: quiet }), /no app: pass --base-url ios-simulator:\/\/<device UDID>\/<bundle id>, or --serve "<command>"/);
});

test('an iOS app takes no --port and no --serve-dir, and a page script takes no simulator URL', async () => {
  await assert.rejects(ensureIosApp({ serve: 'true', port: 3000, log: quiet }), /an iOS app script takes no --port/);
  await assert.rejects(ensureIosApp({ serveDir: '.', log: quiet }), /an iOS app is not served from a directory/);
  await assert.rejects(ensureServer({ baseUrl: APP_URL, log: quiet }), /names an iOS app on a simulator, which a script that declares \*\*Platform:\*\* iOS drives/);
});

test("an iOS app's --serve command is ready once it prints the app's simulator URL, gets no key the engine holds, and is stopped with SIGTERM", async () => {
  await withStandIn(async (dir, record) => {
    const saved = { bypass: process.env.VERCEL_AUTOMATION_BYPASS_SECRET, speech: process.env.OPENAI_API_KEY };
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'stand-in-bypass';
    process.env.OPENAI_API_KEY = 'stand-in-speech';
    let app;
    try {
      app = await ensureIosApp({ serve: `node start.mjs ${record} ready`, cwd: dir, log: quiet });
    } finally {
      for (const [k, v] of [['VERCEL_AUTOMATION_BYPASS_SECRET', saved.bypass], ['OPENAI_API_KEY', saved.speech]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    assert.equal(app.baseUrl, APP_URL);
    assert.deepEqual(JSON.parse(readFileSync(`${record}.env`, 'utf8')), { bypass: false, speech: false, path: true });
    assert.equal(existsSync(`${record}.stopped`), false);
    await app.stop();
    assert.equal(existsSync(`${record}.stopped`), true, 'the command was told to stop, and stop resolved once it had');
  });
});

test("an iOS app's --serve command that exits, leaving running what prints the URL, is ready once the URL comes, and stopping it waits until what it left has stopped", async () => {
  await withStandIn(async (dir, record) => {
    const app = await ensureIosApp({ serve: `node start.mjs ${record} ready slow & exit 0`, cwd: dir, log: quiet });
    assert.equal(app.baseUrl, APP_URL);
    await app.stop();
    assert.equal(existsSync(`${record}.stopped`), true, 'stop resolved once what the command left had taken its second to stop');
  });
});

test("what an iOS app's --serve command left running is killed once it has had the stop timeout to stop, and the log says so", async () => {
  await withStandIn(async (dir, record) => {
    const lines: string[] = [];
    const app = await ensureIosApp({ serve: `node start.mjs ${record} ready deaf & exit 0`, cwd: dir, stopTimeout: 1500, log: (m) => lines.push(m) });
    const pid = Number(readFileSync(`${record}.pid`, 'utf8'));
    const asked = Date.now();
    await app.stop();
    assert.ok(Date.now() - asked >= 1500, 'it had the stop timeout to stop');
    await ended(pid);
    assert.match(lines.join('\n'), /what `node start\.mjs .* ready deaf & exit 0` started did not all exit within 1\.5s of SIGTERM, so what was left was killed/);
  });
});

test("an iOS app's --serve command that exits before it prints a URL has what it left running stopped before the start fails", async () => {
  await withStandIn(async (dir, record) => {
    // What it starts sends its output elsewhere, so the command's own output ends with it.
    const command = `node start.mjs ${record} silent > /dev/null 2>&1 & until [ -e ${record}.pid ]; do sleep 0.05; done; exit 3`;
    await assert.rejects(ensureIosApp({ serve: command, cwd: dir, log: quiet }), /exited 3 before it printed its app's simulator URL/);
    assert.equal(existsSync(`${record}.stopped`), true, 'what the command left was stopped');
  });
});

test("an iOS app's --serve command that exits, or prints no URL in time, fails the start with its last output, and one that runs out of time is stopped", async () => {
  await withStandIn(async (dir, record) => {
    const failed = await ensureIosApp({ serve: `node start.mjs ${record} fail`, cwd: dir, log: quiet }).then(
      () => assert.fail('a command that exits before it prints a URL fails the start'),
      (e: Error) => e.message,
    );
    const said = /^server: `node start\.mjs .* fail` exited 65 before it printed its app's simulator URL, ios-simulator:\/\/<device UDID>\/<bundle id>; its last output: (.*)$/.exec(failed);
    assert.ok(said, failed);
    // Its standard output and its standard error are two pipes, whose lines reach the
    // engine in either order, so only the lines of one stream keep the order it wrote them in.
    const lines = said[1].split(' / ');
    assert.deepEqual([...lines].sort(), ['booting a device; the URL comes once the app is up', 'building the app', 'xcodebuild exited 65'], failed);
    assert.ok(lines.indexOf('building the app') < lines.indexOf('xcodebuild exited 65'), failed);
    await assert.rejects(ensureIosApp({ serve: `node start.mjs ${record} silent`, cwd: dir, readyTimeout: 1500, log: quiet }), /printed no simulator URL, ios-simulator:\/\/<device UDID>\/<bundle id>, within 1.5s/);
    await appears(`${record}.stopped`);
  });
});
