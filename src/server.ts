// The server seam — where the demo's pages come from. Three ways, in precedence order:
//
//   • base-url   reuse a server already running (this run does not own it, so it is not
//                torn down);
//   • serve      spawn an arbitrary dev-server command and wait for it to answer, then
//                tear it down on exit (the generalization of a pinned `npm run dev`);
//   • serve-dir  serve a static directory with a built-in file server, so a demo of a
//                plain static app — and this package's own sample — runs with no external
//                process at all. It listens on a free port unless one is named, so
//                captures running side by side on one host each get their own server.
//
// The start URL in the demo script is always just a path (+ query); the origin comes
// from whichever of these is in effect.
//
// An iOS app script's app comes the same two ways, through the same options
// (ensureIosApp). `--base-url` takes the simulator URL of an app already running on a
// booted device, ios-simulator://<device UDID>/<bundle id> (simulator.ts). `--serve` takes
// the repo's command that brings the app up on a simulator: the engine starts it, waits
// until it prints the app's simulator URL on its standard output, which says the app is up
// and where, and stops it once the run ends, as it does a dev server. A port has no
// meaning for an app on a simulator, and an app is not served from a directory, so
// `--port` and `--serve-dir` are refused. The command runs with the engine's environment
// less the keys the engine holds, as every tool the engine starts for an iOS app does,
// and its stopping can take as long as deleting a device does, which the engine waits
// for.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { isSimulatorUrl, parseSimulatorUrl, simulatorUrl, toolEnv, SIMULATOR_URL_FORM } from './simulator.ts';

/** The port a `serve` command is polled on when no port is named. */
export const DEFAULT_PORT = 5173;

export interface ServeOptions {
  /** Reuse a running server at this origin, or an iOS app at this simulator URL; nothing is spawned or torn down. */
  baseUrl?: string | null;
  /** Shell command to spawn as the dev server (e.g. `npm run dev`), or that brings an iOS app up on a simulator and prints its URL. */
  serve?: string | null;
  /** Directory to serve with the built-in static file server. */
  serveDir?: string | null;
  /**
   * Port for `serve` / `serveDir`, a whole number from 1 to 65535. A `serve` command binds
   * the port it chooses, so it is polled on DEFAULT_PORT unless this names another.
   * `serveDir` listens on a free port the system assigns unless this names one.
   */
  port?: number;
  /**
   * Working directory for the `serve` command (default: process cwd). The capture
   * commands also start a terminal script's shell here.
   */
  cwd?: string;
  /** Path polled for readiness of a spawned `serve` command (default `/`). */
  readyPath?: string;
  log?: (m: string) => void;
}

export interface ServerHandle {
  /** Origin the driver joins the start path onto, e.g. `http://localhost:5173`. */
  baseUrl: string;
  /** Tear down anything this run started; a no-op for a reused base-url. */
  stop(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True once a GET to `url` succeeds. */
async function serverUp(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: 'GET' })).ok;
  } catch {
    return false;
  }
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await serverUp(url)) return true;
    await sleep(250);
  }
  return false;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
};

/** Minimal static file server: resolves within `root`, serves `index.html` for a directory, 404s the rest. */
function staticServer(root: string): Server {
  const abs = path.resolve(root);
  return createServer((req, res) => {
    let urlPath: string;
    try {
      urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      // A malformed percent-escape would otherwise throw and take the server down.
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request');
      return;
    }
    let file = path.join(abs, urlPath);
    // Contain traversal: anything resolving outside root is a 403. The `+ sep` guard
    // keeps a sibling whose name shares the root's prefix (…/app-x vs …/app) out; the
    // root directory itself (file === abs) is allowed.
    if (file !== abs && !file.startsWith(abs + path.sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
}

/**
 * Bring up the server the demo runs against and return a handle. Throws when none of
 * base-url / serve / serve-dir is given, since the driver has nowhere to point, and
 * when the port named is not one a server can listen on.
 */
export async function ensureServer(opts: ServeOptions): Promise<ServerHandle> {
  const log = opts.log ?? ((m: string) => console.log(m));
  // Checked before anything is served or spawned. Past this point a bad port reaches
  // listen(), or a `serve` command is spawned and its readiness URL polled for 30s.
  if (opts.port !== undefined && !(Number.isInteger(opts.port) && opts.port >= 1 && opts.port <= 65535)) {
    throw new Error(`server: the port must be a whole number from 1 to 65535 (got ${opts.port})`);
  }

  if (opts.baseUrl && isSimulatorUrl(opts.baseUrl)) {
    throw new Error(`server: ${opts.baseUrl} names an iOS app on a simulator, which a script that declares **Platform:** iOS drives; this script drives a page, at a web app's origin`);
  }

  if (opts.baseUrl) {
    const baseUrl = opts.baseUrl.replace(/\/$/, '');
    log(`server: using ${baseUrl}`);
    return { baseUrl, stop: async () => {} };
  }

  if (opts.serveDir) {
    const server = staticServer(opts.serveDir);
    // Port 0 asks the system for a free one. A named port that is taken rejects the
    // start, instead of raising an 'error' event nothing handles.
    await new Promise<void>((resolve, reject) => {
      const fail = (e: Error): void => reject(new Error(`server: cannot serve ${opts.serveDir}: ${e.message}`));
      server.once('error', fail);
      server.listen(opts.port ?? 0, () => {
        server.off('error', fail);
        resolve();
      });
    });
    const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
    log(`server: serving ${path.resolve(opts.serveDir)} at ${baseUrl}`);
    return { baseUrl, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  if (opts.serve) {
    const port = opts.port ?? DEFAULT_PORT;
    const baseUrl = `http://localhost:${port}`;
    const ready = baseUrl + (opts.readyPath ?? '/');
    if (await serverUp(ready)) {
      log(`server: reusing what is already serving on :${port}`);
      return { baseUrl, stop: async () => {} };
    }
    log(`server: starting \`${opts.serve}\` on :${port}…`);
    // Detached so the whole process group can be torn down (a dev server spawns children).
    const child = spawn(opts.serve, { cwd: opts.cwd ?? process.cwd(), stdio: 'ignore', detached: true, shell: true });
    child.unref();
    const ok = await waitForServer(ready, 30000);
    if (!ok) {
      stopChild(child);
      throw new Error(`server: \`${opts.serve}\` did not answer on ${ready} within 30s`);
    }
    log(`server: ready on :${port}`);
    return { baseUrl, stop: async () => stopChild(child) };
  }

  throw new Error('no server: pass --base-url <url>, --serve "<command>", or --serve-dir <dir>');
}

/** How long an iOS app's `--serve` command has to print its app's simulator URL. Building the app and booting a device can take minutes. */
export const IOS_READY_TIMEOUT_MS = 600_000;
/** How long an iOS app's `--serve` command has to exit once told to stop, which can mean deleting its device, before it is killed. */
const IOS_STOP_MS = 60_000;
/** How many of the last lines a `--serve` command printed are kept, for the message of one that fails. */
const OUTPUT_LINES = 5;

/**
 * Bring up the iOS app an iOS app script drives, and return a handle whose base URL is the
 * app's simulator URL: the app `baseUrl` names, already running, or the app a `serve`
 * command brings up and names by printing its simulator URL on a line of its standard
 * output. Throws when neither is given, when the URL is not a simulator URL, when the
 * command exits or runs out of time before it prints one, or when `serveDir` or `port`
 * is given.
 */
export async function ensureIosApp(opts: ServeOptions & { readyTimeout?: number }): Promise<ServerHandle> {
  const log = opts.log ?? ((m: string) => console.log(m));
  if (opts.serveDir) throw new Error(`server: an iOS app is not served from a directory; pass --base-url ${SIMULATOR_URL_FORM}, or --serve "<command>" that brings the app up and prints that URL`);
  if (opts.port !== undefined) throw new Error("server: an iOS app script takes no --port; its --serve command prints the app's simulator URL once the app is up");
  if (opts.baseUrl) {
    const app = parseSimulatorUrl(opts.baseUrl);
    if (!app) throw new Error(`server: an iOS app script takes its app's simulator URL, ${SIMULATOR_URL_FORM}, as --base-url (got "${opts.baseUrl}")`);
    log(`app: using ${simulatorUrl(app)}`);
    return { baseUrl: simulatorUrl(app), stop: async () => {} };
  }
  if (opts.serve) return serveIosApp(opts.serve, opts.cwd ?? process.cwd(), opts.readyTimeout ?? IOS_READY_TIMEOUT_MS, log);
  throw new Error(`no app: pass --base-url ${SIMULATOR_URL_FORM}, or --serve "<command>" that brings the app up and prints that URL`);
}

/** Start `command`, and resolve once it prints a simulator URL, with a handle that stops it. */
async function serveIosApp(command: string, cwd: string, readyTimeout: number, log: (m: string) => void): Promise<ServerHandle> {
  log(`app: starting \`${command}\`…`);
  // Detached, so its whole process group can be stopped: the command starts children.
  const child = spawn(command, { cwd, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: true });
  child.unref();
  const output: string[] = [];
  const keep = (line: string): void => {
    if (!line.trim()) return;
    output.push(line.trim());
    output.splice(0, Math.max(0, output.length - OUTPUT_LINES));
  };
  let partial = { out: '', err: '' };
  let found: string | null = null;
  const read = (stream: 'out' | 'err', data: Buffer): void => {
    const lines = (partial[stream] + data.toString('utf8')).split('\n');
    partial = { ...partial, [stream]: lines.pop() ?? '' };
    for (const line of lines) {
      keep(line);
      if (stream === 'out' && !found) {
        const app = parseSimulatorUrl(line.match(/ios-simulator:\/\/\S+/i)?.[0] ?? '');
        if (app) found = simulatorUrl(app);
      }
    }
  };
  // The streams are read to their end, so a command that keeps printing never blocks on a full pipe.
  child.stdout?.on('data', (d: Buffer) => read('out', d));
  child.stderr?.on('data', (d: Buffer) => read('err', d));
  let exit: string | null = null;
  // The command's last lines, its URL among them, can reach the engine after its exit, so
  // it has ended once its output is read to the end ('close'), not once it exits.
  child.once('close', (code, signal) => {
    exit = signal ? `was ended by ${signal}` : `exited ${code}`;
  });
  child.once('error', (e) => {
    exit = `could not start: ${e.message}`;
  });

  const stop = async (): Promise<void> => {
    if (!(await stopGroup(child, IOS_STOP_MS))) log(`app: \`${command}\` did not exit within ${IOS_STOP_MS / 1000}s of SIGTERM, so it was killed`);
  };
  const said = (): string => (output.length ? `; its last output: ${output.join(' / ')}` : '');
  const deadline = Date.now() + readyTimeout;
  while (!found) {
    if (exit) throw new Error(`server: \`${command}\` ${exit} before it printed its app's simulator URL, ${SIMULATOR_URL_FORM}${said()}`);
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`server: \`${command}\` printed no simulator URL, ${SIMULATOR_URL_FORM}, within ${readyTimeout / 1000}s${said()}`);
    }
    await sleep(100);
  }
  log(`app: ready at ${found}`);
  return { baseUrl: found, stop };
}

/**
 * Stop `child`'s process group with SIGTERM, and resolve once it has exited, or with
 * SIGKILL `ms` later. Resolves whether SIGTERM ended it. The group is told to stop even
 * when `child` has exited, since what it started can outlive it.
 */
async function stopGroup(child: ChildProcess, ms: number): Promise<boolean> {
  const done = (): boolean => child.exitCode !== null || child.signalCode !== null;
  stopChild(child);
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(100);
  if (done()) return true;
  try {
    process.kill(-(child.pid as number), 'SIGKILL');
  } catch {
    /* it has ended */
  }
  return false;
}

function stopChild(child: ChildProcess): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // the process group
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
}
