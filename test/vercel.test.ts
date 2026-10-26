// Tests for passing Vercel's sign-in (src/vercel.ts), and for capturing an app behind it.
//
// A stub server stands in for a deployment behind Vercel's Deployment Protection and
// answers as Vercel was measured to answer. A request with neither the key nor the bypass
// cookie gets a 302 to vercel.com/sso-api. One with the key and x-vercel-set-bypass-cookie
// gets a 307 to the same URL that sets _vercel_jwt. One with the cookie, or with the key
// alone, gets the app. A path the stub has moved gets a 308 before any of that, as Vercel
// answers a deployment's http:// URL with its https:// URL. The app's page loads a script
// and an image from a second stub server, on another origin. Each stub records the
// requests it is sent, and whether the browser made each one: a request the browser makes
// carries Sec-Fetch-Mode, and one the engine makes outside the page carries none.
//
// The capture tests run the CLI with the key in its environment, as a session carries it.
// A capture that passes the sign-in, or stops at it, never follows the redirect to
// vercel.com, so no request leaves the host. The tests that open a page need a headless
// Chromium and skip without one (see browser-fixture.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

import { isVercelSignIn, mayReceiveKey, passVercelSignIn, VERCEL_BYPASS_VAR } from '../src/vercel.ts';
import { openSurface } from '../src/browser.ts';
import { parseDemoScript } from '../src/demo-script.ts';
import { launchBrowser, runCli, scratchDir, stubFfmpeg, writeFiles, stepLines } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const quiet = (): void => {};

/** A request a stub was sent: its path, the bypass headers and the cookies it carried, and whether the browser made it. */
interface Seen {
  path: string;
  key: string | null;
  setCookie: string | null;
  cookie: string;
  browser: boolean;
}

interface Stub {
  origin: string;
  seen: Seen[];
  close(): Promise<void>;
}

/** Serve `handle` on a free port, named by `host` in its origin, recording each request it is sent. */
async function stub(host: string, handle: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const header = (name: string): string | null => (typeof req.headers[name] === 'string' ? (req.headers[name] as string) : null);
    seen.push({ path: req.url ?? '', key: header('x-vercel-protection-bypass'), setCookie: header('x-vercel-set-bypass-cookie'), cookie: req.headers.cookie ?? '', browser: req.headers['sec-fetch-mode'] !== undefined });
    handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return {
    origin: `http://${host}:${(server.address() as AddressInfo).port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The other origin: a script that marks the page it runs in, and an image. */
function otherOrigin(req: IncomingMessage, res: ServerResponse): void {
  if ((req.url ?? '').startsWith('/widget.js')) {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end("document.body.dataset.widget = 'loaded';");
    return;
  }
  res.writeHead(200, { 'content-type': 'image/svg+xml' });
  res.end('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#1f6feb"/></svg>');
}

/** The app's page: a heading, then an image and a script from `other`. */
function appPage(other: string): string {
  return `<!doctype html><title>An app behind Vercel's sign-in</title><h1 id="app">The app</h1><img src="${other}/pixel.svg"><script src="${other}/widget.js"></script>`;
}

interface DeploymentOptions {
  /** Let every request pass. */
  protect?: boolean;
  /** Drop the connection of a request that carries a key, unanswered. */
  onKey?: 'drop';
  /** Paths answered with a 308 to the URL each maps to, before the protection answers. */
  moved?: Record<string, string>;
  /** Answer a request that passes with a 302 to this URL, instead of the page. */
  onward?: string;
}

/** A deployment behind Vercel's Deployment Protection whose bypass key is `key`, serving `page` to a request that passes. */
function deployment(key: string, page: string, opts: DeploymentOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const token = randomUUID();
  return (req, res) => {
    const moved = opts.moved?.[req.url ?? ''];
    if (moved !== undefined) {
      res.writeHead(308, { location: moved });
      res.end();
      return;
    }
    const sent = req.headers['x-vercel-protection-bypass'];
    if (sent !== undefined && opts.onKey === 'drop') {
      req.socket.destroy();
      return;
    }
    const url = `http://${req.headers.host}${req.url}`;
    const cookie = (req.headers.cookie ?? '').split(/;\s*/).includes(`_vercel_jwt=${token}`);
    if (opts.protect !== false && !cookie && sent !== key) {
      res.writeHead(302, { location: `https://vercel.com/sso-api?url=${encodeURIComponent(url)}&nonce=n0nce`, 'set-cookie': '_vercel_sso_nonce=n0nce; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax' });
      res.end();
      return;
    }
    if (opts.protect !== false && !cookie && req.headers['x-vercel-set-bypass-cookie'] === 'true') {
      res.writeHead(307, { location: url, 'set-cookie': `_vercel_jwt=${token}; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` });
      res.end();
      return;
    }
    if (opts.onward) {
      res.writeHead(302, { location: opts.onward });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
  };
}

/** A deployment on 127.0.0.1 whose page loads from a stub on localhost, another origin; `use` gets both, and both are closed after. */
async function withDeployment(key: string, opts: DeploymentOptions, use: (app: Stub, other: Stub) => Promise<void>): Promise<void> {
  const other = await stub('localhost', otherOrigin);
  const app = await stub('127.0.0.1', deployment(key, appPage(other.origin), opts));
  try {
    await use(app, other);
  } finally {
    await app.close();
    await other.close();
  }
}

const START = '/board?view=week';
/** Where a deployment that has moved its start path redirects a request for it. */
const MOVED = '/boards/week';

const DEMO = `# Demo: An app behind Vercel's sign-in

**Start:** \`${START}\`

## Steps

1. **The app shows, with a widget another origin serves**
   \`waitFor #app\`
   _Prove:_ the widget ran — \`eval document.body.dataset.widget === 'loaded'\`
`;

/** A fresh bypass key, unlike any string a capture writes on its own. */
const freshKey = (): string => `bypass-key-${randomUUID()}`;

/** The CLI's environment: no narration key, a stand-in ffmpeg, and `key` as the bypass key, or none. */
function cliEnv(dir: string, key?: string): NodeJS.ProcessEnv {
  const { [VERCEL_BYPASS_VAR]: _bypass, OPENAI_API_KEY: _narration, ...rest } = process.env;
  return { ...rest, FFMPEG_BIN: stubFfmpeg(dir), ...(key ? { [VERCEL_BYPASS_VAR]: key } : {}) };
}

/** Every file under `dir`, at any depth. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

test('the sign-in is a redirect to vercel.com/sso-api, and no other answer is', () => {
  const url = 'https://app-git-branch-team.vercel.app/board';
  assert.equal(isVercelSignIn(302, 'https://vercel.com/sso-api?url=https%3A%2F%2Fapp-git-branch-team.vercel.app%2Fboard&nonce=n', url), true);
  assert.equal(isVercelSignIn(307, 'https://vercel.com/sso-api', url), true);
  assert.equal(isVercelSignIn(200, 'https://vercel.com/sso-api', url), false);
  assert.equal(isVercelSignIn(300, 'https://vercel.com/sso-api', url), false);
  assert.equal(isVercelSignIn(302, undefined, url), false);
  assert.equal(isVercelSignIn(302, '/sso-api', url), false);
  assert.equal(isVercelSignIn(302, 'https://vercel.com/login', url), false);
  assert.equal(isVercelSignIn(302, 'https://vercel.com/sso-apis', url), false);
  assert.equal(isVercelSignIn(302, 'https://vercel.com.example/sso-api', url), false);
  assert.equal(isVercelSignIn(302, 'https://example.com/?next=https://vercel.com/sso-api', url), false);
  assert.equal(isVercelSignIn(302, 'http://[', url), false);
});

test("the key may go to the start URL's origin and to its host over https, and to no other origin", () => {
  const start = 'http://app-git-branch-team.vercel.app/board?view=week';
  assert.equal(mayReceiveKey(start, start), true);
  assert.equal(mayReceiveKey(start, 'http://app-git-branch-team.vercel.app/boards/week'), true);
  assert.equal(mayReceiveKey(start, 'https://app-git-branch-team.vercel.app/board?view=week'), true);
  assert.equal(mayReceiveKey(start, 'http://app-git-branch-team.vercel.app:8080/board'), false);
  assert.equal(mayReceiveKey(start, 'https://other-git-branch-team.vercel.app/board'), false);
  assert.equal(mayReceiveKey(start, 'https://app-git-branch-team.vercel.app.example/board'), false);
  assert.equal(mayReceiveKey('https://app-git-branch-team.vercel.app/board', 'http://app-git-branch-team.vercel.app/board'), false);
});

// Each test serves its own deployment and opens its own page, or runs its own capture, so they run side by side.
describe("passing Vercel's sign-in", { concurrency: true, skip }, () => {
  test('with the key in its environment, a capture of an app behind the sign-in sends the key once, to the app alone, and writes it nowhere', async () => {
    const key = freshKey();
    await withDeployment(key, {}, async (app, other) => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'demo.md': DEMO });
        const res = await runCli(['run', path.join(dir, 'demo.md'), '--mode', 'proof', '--base-url', app.origin, '--no-narrate', '--keep', '-o', path.join(dir, 'out.mp4')], { cwd: dir, env: cliEnv(dir, key) });
        assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
        assert.ok(res.stdout.includes(`vercel: ${VERCEL_BYPASS_VAR} passed Vercel's sign-in at ${app.origin}\n`), res.stdout);
        assert.deepEqual(stepLines(res.stdout).filter((l) => l.startsWith('  ')), ['  ✓ proof held']);

        // One request carried the key: the engine's, for the start path, asking for the cookie.
        const keyed = app.seen.filter((s) => s.key !== null);
        assert.deepEqual(keyed.map((s) => [s.path, s.key, s.setCookie, s.browser]), [[START, key, 'true', false]]);
        // The page's requests to the app carried the cookie the key earned instead.
        const fromPage = app.seen.filter((s) => s.browser);
        assert.ok(fromPage.length > 0 && fromPage.every((s) => s.cookie.includes('_vercel_jwt=')), JSON.stringify(app.seen));
        // The page loaded the other origin's script and image, and neither request carried the key.
        assert.deepEqual(other.seen.map((s) => s.path).sort(), ['/pixel.svg', '/widget.js']);
        assert.ok(other.seen.every((s) => s.key === null && s.setCookie === null), JSON.stringify(other.seen));

        // The key is in no output and in no file the capture wrote, its kept working dir included.
        assert.ok(!`${res.stdout}${res.stderr}`.includes(key), 'the output holds the key');
        const files = filesUnder(dir);
        assert.ok(files.some((f) => f.includes(`${path.sep}.captures${path.sep}`) && f.endsWith('manifest.json')), `no kept working dir in ${files.join(', ')}`);
        assert.deepEqual(files.filter((f) => readFileSync(f).includes(key)), []);
      } finally {
        cleanup();
      }
    });
  });

  test('without the key, a capture of an app behind the sign-in fails and says it reached the sign-in, and the browser never asks for the app', async () => {
    await withDeployment(freshKey(), {}, async (app, other) => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'demo.md': DEMO });
        const png = path.join(dir, 'out.png');
        const res = await runCli(['screenshot', path.join(dir, 'demo.md'), '--base-url', app.origin, '-o', png], { cwd: dir, env: cliEnv(dir) });
        assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
        assert.ok(
          res.stderr.includes(`vercel: the capture reached Vercel's sign-in at ${app.origin}, a redirect to vercel.com/sso-api, so it stops rather than film the sign-in page. Set ${VERCEL_BYPASS_VAR} to the project's Protection Bypass for Automation key to pass it.`),
          res.stderr,
        );
        assert.equal(existsSync(png), false);
        assert.deepEqual(app.seen.map((s) => [s.path, s.key, s.browser]), [[START, null, false]]);
        assert.deepEqual(other.seen, []);
      } finally {
        cleanup();
      }
    });
  });

  test('with the key, a capture whose start path redirects before the sign-in passes it where the redirect leads, and sends the key there alone', async () => {
    const key = freshKey();
    await withDeployment(key, { moved: { [START]: MOVED } }, async (app, other) => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'demo.md': DEMO });
        const png = path.join(dir, 'out.png');
        const res = await runCli(['screenshot', path.join(dir, 'demo.md'), '--base-url', app.origin, '-o', png], { cwd: dir, env: cliEnv(dir, key) });
        assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
        assert.ok(res.stdout.includes(`vercel: ${VERCEL_BYPASS_VAR} passed Vercel's sign-in at ${app.origin}\n`), res.stdout);
        assert.equal(existsSync(png), true);

        // The engine followed the redirect to the sign-in, sent the key there once, and walked the way again.
        assert.deepEqual(
          app.seen.filter((s) => !s.browser).map((s) => [s.path, s.key, s.setCookie]),
          [[START, null, null], [MOVED, null, null], [MOVED, key, 'true'], [START, null, null], [MOVED, null, null]],
        );
        // The browser followed the same redirect, and its requests carried the cookie the key earned.
        const fromPage = app.seen.filter((s) => s.browser);
        assert.deepEqual(fromPage.slice(0, 2).map((s) => s.path), [START, MOVED]);
        assert.ok(fromPage.every((s) => s.key === null && s.cookie.includes('_vercel_jwt=')), JSON.stringify(app.seen));
        assert.ok(other.seen.length > 0 && other.seen.every((s) => s.key === null), JSON.stringify(other.seen));
        assert.ok(!`${res.stdout}${res.stderr}`.includes(key), 'the output holds the key');
      } finally {
        cleanup();
      }
    });
  });

  test('without the key, a capture whose start path redirects before the sign-in fails and says it reached the sign-in, and the browser never asks for the app', async () => {
    await withDeployment(freshKey(), { moved: { [START]: MOVED } }, async (app, other) => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'demo.md': DEMO });
        const png = path.join(dir, 'out.png');
        const res = await runCli(['screenshot', path.join(dir, 'demo.md'), '--base-url', app.origin, '-o', png], { cwd: dir, env: cliEnv(dir) });
        assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
        assert.ok(
          res.stderr.includes(`vercel: the capture reached Vercel's sign-in at ${app.origin}, a redirect to vercel.com/sso-api, so it stops rather than film the sign-in page. Set ${VERCEL_BYPASS_VAR} to the project's Protection Bypass for Automation key to pass it.`),
          res.stderr,
        );
        assert.equal(existsSync(png), false);
        assert.deepEqual(app.seen.map((s) => [s.path, s.key, s.browser]), [[START, null, false], [MOVED, null, false]]);
        assert.deepEqual(other.seen, []);
      } finally {
        cleanup();
      }
    });
  });

  test('an app that does not answer with the sign-in is never sent the key', async () => {
    const key = freshKey();
    await withDeployment(key, { protect: false }, async (app, other) => {
      const page = await browser!.newPage();
      try {
        const lines: string[] = [];
        await passVercelSignIn(page, app.origin + START, (m) => lines.push(m), { [VERCEL_BYPASS_VAR]: key });
        await page.goto(app.origin + START);
        assert.equal(await page.locator('#app').textContent(), 'The app');
        assert.deepEqual(lines, []);
        assert.deepEqual(app.seen.map((s) => [s.path, s.browser]).slice(0, 2), [[START, false], [START, true]]);
        assert.ok([...app.seen, ...other.seen].every((s) => s.key === null), JSON.stringify([...app.seen, ...other.seen]));
      } finally {
        await page.close();
      }
    });
  });

  test('a key the deployment refuses stops the capture before the page asks for the app, and the error names the variable, not the key', async () => {
    const wrong = freshKey();
    await withDeployment(freshKey(), {}, async (app) => {
      const page = await browser!.newPage();
      try {
        await assert.rejects(passVercelSignIn(page, app.origin + START, quiet, { [VERCEL_BYPASS_VAR]: wrong }), {
          message: `vercel: the capture reached Vercel's sign-in at ${app.origin}, and it still answers with the sign-in once ${VERCEL_BYPASS_VAR} is sent, so the key does not pass this deployment's protection.`,
        });
        // Asked without the key, sent it once, asked again; each answered with the sign-in.
        assert.deepEqual(app.seen.map((s) => [s.key, s.browser]), [[null, false], [wrong, false], [null, false]]);
        assert.equal(page.url(), 'about:blank');
      } finally {
        await page.close();
      }
    });
  });

  test('a request carrying the key that fails stops the capture, and the error lists none of its headers', async () => {
    const key = freshKey();
    await withDeployment(key, { onKey: 'drop' }, async (app) => {
      const page = await browser!.newPage();
      try {
        await assert.rejects(passVercelSignIn(page, app.origin + START, quiet, { [VERCEL_BYPASS_VAR]: key }), (e: Error) => {
          assert.match(e.message, new RegExp(`^vercel: the capture reached Vercel's sign-in at ${app.origin.replace(/\./g, '\\.')}, and the request carrying ${VERCEL_BYPASS_VAR} failed: apiRequestContext\\.get: [^\\n]+$`));
          assert.ok(!e.message.includes(key), e.message);
          return true;
        });
        assert.equal(page.url(), 'about:blank');
      } finally {
        await page.close();
      }
    });
  });

  test('a sign-in on another host the start path redirects to stops the capture, and neither host is sent the key', async () => {
    const key = freshKey();
    const app = await stub('localhost', deployment(key, '<h1 id="app">The app</h1>'));
    const front = await stub('127.0.0.1', (req, res) => {
      res.writeHead(302, { location: app.origin + (req.url ?? '/') });
      res.end();
    });
    const page = await browser!.newPage();
    try {
      await assert.rejects(passVercelSignIn(page, front.origin + START, quiet, { [VERCEL_BYPASS_VAR]: key }), {
        message: `vercel: the capture's start path redirects to Vercel's sign-in at ${app.origin}, and ${VERCEL_BYPASS_VAR} goes only to the base URL's origin or to its host over https, so the capture stops rather than film the sign-in page. Give ${app.origin} as the base URL to pass it.`,
      });
      assert.deepEqual(front.seen.map((s) => [s.path, s.key]), [[START, null]]);
      assert.deepEqual(app.seen.map((s) => [s.path, s.key]), [[START, null]]);
      assert.equal(page.url(), 'about:blank');
    } finally {
      await page.close();
      await front.close();
      await app.close();
    }
  });

  test('a sign-in on another host past the one the key passed stops the capture, and the key went to the first host alone', async () => {
    const key = freshKey();
    const next = await stub('localhost', deployment(freshKey(), '<h1 id="app">Another app</h1>'));
    const app = await stub('127.0.0.1', deployment(key, '', { onward: `${next.origin}/elsewhere` }));
    const page = await browser!.newPage();
    try {
      await assert.rejects(passVercelSignIn(page, app.origin + START, quiet, { [VERCEL_BYPASS_VAR]: key }), {
        message: `vercel: ${VERCEL_BYPASS_VAR} passed Vercel's sign-in at ${app.origin}, and past it the start path redirects to Vercel's sign-in at ${next.origin}, so the capture stops rather than film the sign-in page.`,
      });
      assert.deepEqual(app.seen.map((s) => [s.path, s.key]), [[START, null], [START, key], [START, null]]);
      assert.deepEqual(next.seen.map((s) => [s.path, s.key]), [['/elsewhere', null]]);
      assert.equal(page.url(), 'about:blank');
    } finally {
      await page.close();
      await app.close();
      await next.close();
    }
  });

  test('a start path whose redirects never end is left to the browser after as many requests as a navigation makes, and the key stays unsent', async () => {
    const key = freshKey();
    await withDeployment(key, { moved: { [START]: START } }, async (app) => {
      const page = await browser!.newPage();
      try {
        await passVercelSignIn(page, app.origin + START, quiet, { [VERCEL_BYPASS_VAR]: key });
        assert.equal(app.seen.length, 20);
        assert.ok(app.seen.every((s) => s.path === START && s.key === null && !s.browser), JSON.stringify(app.seen));
        assert.equal(page.url(), 'about:blank');
      } finally {
        await page.close();
      }
    });
  });

  test('an origin the engine cannot reach is left to the browser, so a page a route serves still opens', async () => {
    const page = await browser!.newPage();
    try {
      await page.route('http://app.sprintshow.invalid/**', (r) => r.fulfill({ contentType: 'text/html', body: '<h1 id="app">routed</h1>' }));
      const lines: string[] = [];
      const surface = await openSurface(page, parseDemoScript(DEMO), { baseUrl: 'http://app.sprintshow.invalid', log: (m) => lines.push(m) });
      await surface.close();
      assert.equal(await page.locator('#app').textContent(), 'routed');
      assert.deepEqual(lines, []);
    } finally {
      await page.close();
    }
  });
});
