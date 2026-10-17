// Tests for the server seam (src/server.ts): the built-in static server behind
// `--serve-dir`.
//
// With no port named it listens on one the system assigns, so two captures on one host
// each get a server of their own. A named port that is taken fails the start with an
// error the caller can report, and a port no server can listen on is refused before
// anything is served or spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ensureServer } from '../src/server.ts';

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
