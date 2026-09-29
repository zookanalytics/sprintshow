// The server seam — where the demo's pages come from. Three ways, in precedence order:
//
//   • base-url   reuse a server already running (this run does not own it, so it is not
//                torn down);
//   • serve      spawn an arbitrary dev-server command and wait for it to answer, then
//                tear it down on exit (the generalization of a pinned `npm run dev`);
//   • serve-dir  serve a static directory with a built-in file server, so a demo of a
//                plain static app — and this package's own sample — runs with no external
//                process at all.
//
// The start URL in the demo script is always just a path (+ query); the origin comes
// from whichever of these is in effect.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PORT = 5173;

export interface ServeOptions {
  /** Reuse a running server at this origin; nothing is spawned or torn down. */
  baseUrl?: string | null;
  /** Shell command to spawn as the dev server (e.g. `npm run dev`). */
  serve?: string | null;
  /** Directory to serve with the built-in static file server. */
  serveDir?: string | null;
  /** Port for `serve` / `serveDir` (default 5173). */
  port?: number;
  /** Working directory for the `serve` command (default: process cwd). */
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
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let file = path.join(abs, urlPath);
    // Contain traversal: anything resolving outside root is a 403.
    if (!file.startsWith(abs)) {
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
 * base-url / serve / serve-dir is given, since the driver has nowhere to point.
 */
export async function ensureServer(opts: ServeOptions): Promise<ServerHandle> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const port = opts.port ?? DEFAULT_PORT;

  if (opts.baseUrl) {
    const baseUrl = opts.baseUrl.replace(/\/$/, '');
    log(`server: using ${baseUrl}`);
    return { baseUrl, stop: async () => {} };
  }

  if (opts.serveDir) {
    const server = staticServer(opts.serveDir);
    await new Promise<void>((resolve) => server.listen(port, resolve));
    const baseUrl = `http://localhost:${port}`;
    log(`server: serving ${path.resolve(opts.serveDir)} at ${baseUrl}`);
    return { baseUrl, stop: () => new Promise<void>((resolve) => server.close(() => resolve())) };
  }

  if (opts.serve) {
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
