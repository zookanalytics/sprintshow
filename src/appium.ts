// Appium, which drives an iOS app for the engine: where it is installed, the server a run
// starts, the WebDriver client the engine speaks to it with, and the frames WebDriverAgent
// streams of the device's screen.
//
// Appium and its XCUITest driver are not dependencies of the package, so an install that
// drives no iOS app does not carry them. `sprintshow provision appium` installs them with
// npm, at the versions APPIUM_PACKAGES pins, into Appium's home in the user's cache, one
// home for each pair of versions. Appium reads its extensions from the node_modules
// directory of its home (APPIUM_HOME). A run that finds the home missing fails with that
// command.
//
// The server is a child of the engine, started for one run and stopped when the run ends.
// It gets the engine's environment less the keys the engine holds (toolEnv), so no key
// reaches Appium or what it starts: the XCUITest driver, simctl, xcodebuild and
// WebDriverAgent. npm, when it installs them, gets the same environment. The server listens
// on a free port of the loopback interface. What it prints is kept a whole line at a time,
// its last lines only, for the message of a session that does not start.
//
// The client speaks the W3C WebDriver protocol over fetch, with Appium's extensions: its
// `mobile:` scripts and its settings. WebdriverIO's clients need Node 22.23.4 or later on
// the 22 line, above the engine's floor of 22.18, and the engine sends a dozen commands.
//
// WebDriverAgent streams the screen as MJPEG: a multipart HTTP response with a JPEG in
// each part, each part's length in its Content-Length header.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { toolEnv } from './simulator.ts';

/** The packages that drive an iOS app, at the versions the engine drives one with. */
export const APPIUM_PACKAGES: Readonly<Record<'appium' | 'appium-xcuitest-driver', string>> = {
  appium: '3.9.0',
  'appium-xcuitest-driver': '12.22.8',
};

/**
 * The command that installs Appium and its XCUITest driver and builds the driver's runner
 * app, as a project that installed sprintshow runs it. A checkout of sprintshow does not
 * reach its own command through npx, and runs it with `npm run provision:appium`.
 */
export const PROVISION_COMMAND = 'npx sprintshow provision appium';

/** How long Appium has to answer once started. */
const SERVER_START_MS = 60_000;
/** How long Appium has to exit once asked to, before it is killed. */
const SERVER_STOP_MS = 10_000;
/** How many of the last lines Appium printed are kept. */
const LOG_LINES = 60;

/** Listen on a port of the loopback interface that the system assigns, and resolve with the server. */
function listenFree(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/**
 * `count` free ports on the loopback interface, as the system assigns them, each a
 * different one: every port is held until all are known. None is held once they resolve,
 * so another process can take one before its user listens on it.
 */
export async function freePorts(count: number): Promise<number[]> {
  const held = await Promise.allSettled(Array.from({ length: count }, () => listenFree()));
  const servers = held.flatMap((h) => (h.status === 'fulfilled' ? [h.value] : []));
  const ports = servers.map((server) => (server.address() as AddressInfo).port);
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  const failed = held.find((h) => h.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return ports;
}

/** Where Appium's home for the pinned versions is, whether or not it is provisioned. */
function homeDir(): string {
  const { appium, 'appium-xcuitest-driver': driver } = APPIUM_PACKAGES;
  return path.join(homedir(), 'Library', 'Caches', 'sprintshow', 'appium', `${appium}-xcuitest-${driver}`);
}

/** Whether the node_modules directory of `dir` holds every package APPIUM_PACKAGES names. */
function holdsAppium(dir: string): boolean {
  return Object.keys(APPIUM_PACKAGES).every((name) => existsSync(path.join(dir, 'node_modules', name, 'package.json')));
}

/** The pinned versions, as a message names them. */
function pinned(): string {
  return `Appium ${APPIUM_PACKAGES.appium} and its XCUITest driver ${APPIUM_PACKAGES['appium-xcuitest-driver']}`;
}

/**
 * Appium's home: the directory whose node_modules holds Appium and its XCUITest driver.
 * Throws, naming the command that installs them, when they are not installed.
 */
export function appiumHome(): string {
  const home = homeDir();
  if (!holdsAppium(home)) {
    throw new Error(`appium: ${pinned()} are not installed; install them once with \`${PROVISION_COMMAND}\`, or with \`npm run provision:appium\` in a checkout of sprintshow`);
  }
  return home;
}

/**
 * Move the directory `work` to `dir`, and return whether it moved. A `dir` in place that is
 * `whole`, as another run that finished first left it, is kept, because a run may be
 * reading from it, and `work` is left to its caller. One that is not whole is replaced.
 */
export function moveIntoPlace(work: string, dir: string, whole: (dir: string) => boolean): boolean {
  try {
    renameSync(work, dir);
    return true;
  } catch (e) {
    // A rename onto a directory that holds anything fails, so of two runs that finish
    // together, the first to move its directory into place keeps it.
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
  }
  if (whole(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  renameSync(work, dir);
  return true;
}

/**
 * Install Appium and its XCUITest driver into Appium's home, unless they are installed,
 * and resolve with the home. npm installs them as it installs any project's dependencies,
 * into a directory of its own beside the home, which is moved into place once whole, so
 * an install that fails or is stopped leaves no home behind. Of two installs that run at
 * once, the first to finish makes the home, and the other leaves it as it is.
 */
export async function provisionAppium(log: (m: string) => void = (m) => console.log(m)): Promise<string> {
  const home = homeDir();
  if (holdsAppium(home)) {
    log(`appium: ${pinned()} are installed: ${home}`);
    return home;
  }
  mkdirSync(path.dirname(home), { recursive: true });
  const work = mkdtempSync(path.join(path.dirname(home), '.install-'));
  try {
    log(`appium: installing ${pinned()} with npm…`);
    writeFileSync(path.join(work, 'package.json'), `${JSON.stringify({ private: true, dependencies: APPIUM_PACKAGES }, null, 2)}\n`);
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn('npm', ['install', '--no-audit', '--no-fund'], { cwd: work, env: toolEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', (e: NodeJS.ErrnoException) => reject(e.code === 'ENOENT' ? new Error('appium: npm, which installs Appium, is not on PATH') : e));
      child.on('exit', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
    });
    if (status !== 0) throw new Error(`appium: npm exited ${status} installing ${pinned()}`);
    if (!holdsAppium(work)) throw new Error(`appium: npm succeeded but left no ${pinned()}`);
    log(moveIntoPlace(work, home, holdsAppium) ? `appium: installed ${home}` : `appium: ${pinned()} are installed: ${home}`);
    return home;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** A running Appium server. */
export interface AppiumServer {
  /** Its base URL, such as `http://127.0.0.1:4723`. */
  url: string;
  /** The last lines it printed. */
  output(): string[];
  /** Stop it, and resolve once it has exited. */
  stop(): Promise<void>;
}

/** Resolve once `child` has exited, or once `ms` has passed. Resolves whether it exited. */
function exited(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Start an Appium server for one run, and resolve once it answers. */
export async function startAppium(log: (m: string) => void): Promise<AppiumServer> {
  const home = appiumHome();
  const main = path.join(home, 'node_modules', 'appium', 'index.js');
  const [port] = await freePorts(1);
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [main, 'server', '--address', '127.0.0.1', '--port', String(port), '--log-no-colors'], {
    cwd: home,
    env: { ...toolEnv(), APPIUM_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  // Each stream is kept a whole line at a time, and its last line once it ends.
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      lines.push(line);
      lines.splice(0, Math.max(0, lines.length - LOG_LINES));
    });
  }
  let spawnError: Error | null = null;
  child.once('error', (e) => {
    spawnError = e;
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    if (!(await exited(child, SERVER_STOP_MS))) {
      child.kill('SIGKILL');
      await exited(child, SERVER_STOP_MS);
    }
  };

  const deadline = Date.now() + SERVER_START_MS;
  for (;;) {
    if (spawnError) throw new Error(`appium: could not start: ${(spawnError as Error).message}`);
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`appium: the server exited ${child.exitCode ?? child.signalCode} before it answered: ${lines.slice(-3).join(' / ')}`);
    }
    try {
      const res = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`appium: the server did not answer within ${SERVER_START_MS / 1000}s: ${lines.slice(-3).join(' / ')}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`appium: server on ${url}`);
  return { url, output: () => [...lines], stop };
}

/** The key a W3C element reference is sent under. */
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

/** An error a WebDriver command answered with: its W3C error code, such as `no such element`, and its message. */
export class WebDriverError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** An element's place on the screen, in points from its top-left corner. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long one WebDriver command has, other than the one that starts a session. */
const COMMAND_MS = 60_000;

/** Send one WebDriver command, and resolve with its value. Throws a WebDriverError for an error it answers with. */
async function command(url: string, method: 'GET' | 'POST' | 'DELETE', body: unknown, timeout: number): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let value: unknown;
  try {
    value = (JSON.parse(text) as { value: unknown }).value;
  } catch {
    throw new WebDriverError('unknown error', `${method} ${new URL(url).pathname} answered ${res.status} with no JSON: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = (value ?? {}) as { error?: string; message?: string };
    throw new WebDriverError(err.error ?? 'unknown error', (err.message ?? `${res.status}`).split('\n')[0]);
  }
  return value;
}

/** A WebDriver session on an Appium server: the commands the engine sends an iOS app. */
export class AppiumSession {
  readonly id: string;
  readonly capabilities: Record<string, unknown>;
  private readonly base: string;

  private constructor(server: string, id: string, capabilities: Record<string, unknown>) {
    this.base = `${server}/session/${id}`;
    this.id = id;
    this.capabilities = capabilities;
  }

  /** Start a session on the server at `server` with `capabilities`, which `timeout` ms is given. */
  static async start(server: string, capabilities: Record<string, unknown>, timeout: number): Promise<AppiumSession> {
    const value = (await command(`${server}/session`, 'POST', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, timeout)) as { sessionId: string; capabilities: Record<string, unknown> };
    return new AppiumSession(server, value.sessionId, value.capabilities ?? {});
  }

  private send(method: 'GET' | 'POST' | 'DELETE', route: string, body?: unknown): Promise<unknown> {
    return command(this.base + route, method, method === 'POST' ? (body ?? {}) : undefined, COMMAND_MS);
  }

  /** The first element whose accessibility identifier, or label when it has none, is `name`, or null when none is. */
  async find(name: string): Promise<string | null> {
    try {
      return ((await this.send('POST', '/element', { using: 'accessibility id', value: name })) as Record<string, string>)[ELEMENT];
    } catch (e) {
      if (e instanceof WebDriverError && e.code === 'no such element') return null;
      throw e;
    }
  }

  /** Every element whose accessibility identifier, or label when it has none, is `name`. */
  async findAll(name: string): Promise<string[]> {
    return ((await this.send('POST', '/elements', { using: 'accessibility id', value: name })) as Record<string, string>[]).map((e) => e[ELEMENT]);
  }

  async click(element: string): Promise<void> {
    await this.send('POST', `/element/${element}/click`);
  }

  async clear(element: string): Promise<void> {
    await this.send('POST', `/element/${element}/clear`);
  }

  /** Type `text` into the element. */
  async type(element: string, text: string): Promise<void> {
    await this.send('POST', `/element/${element}/value`, { text });
  }

  /** Type `text` into whatever has the keyboard's focus. */
  async keys(text: string): Promise<void> {
    await this.send('POST', '/keys', { value: [...text] });
  }

  async attribute(element: string, name: string): Promise<string | null> {
    const v = await this.send('GET', `/element/${element}/attribute/${name}`);
    return v === null || v === undefined ? null : String(v);
  }

  async displayed(element: string): Promise<boolean> {
    return Boolean(await this.send('GET', `/element/${element}/displayed`));
  }

  async rect(element: string): Promise<Rect> {
    return (await this.send('GET', `/element/${element}/rect`)) as Rect;
  }

  /** The screen's size, in points. */
  async windowRect(): Promise<Rect> {
    return (await this.send('GET', '/window/rect')) as Rect;
  }

  /** A PNG of the screen, at the device's scale. */
  async screenshot(): Promise<Buffer> {
    return Buffer.from((await this.send('GET', '/screenshot')) as string, 'base64');
  }

  /** Run one of Appium's `mobile:` scripts. */
  async execute(script: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.send('POST', '/execute/sync', { script, args: [args] });
  }

  /** Change some of the session's settings. */
  async settings(settings: Record<string, unknown>): Promise<void> {
    await this.send('POST', '/appium/settings', { settings });
  }

  /** End the session. */
  async end(): Promise<void> {
    await this.send('DELETE', '');
  }
}

/** A stream of the frames an MJPEG server sends. */
export interface FrameStream {
  /** Stop reading. */
  close(): void;
}

const HEADER_END = Buffer.from('\r\n\r\n');

/**
 * Read the MJPEG stream at `url`, handing `onFrame` each JPEG once it has arrived whole.
 * `onEnd` is told once the stream ends, unless it was closed, with the error that ended it.
 */
export function readMjpeg(url: string, onFrame: (jpeg: Buffer) => void, onEnd: (error?: Error) => void): FrameStream {
  let closed = false;
  // What has arrived of the parts not yet handed over, kept as it arrived, and its length.
  let chunks: Buffer[] = [];
  let size = 0;
  // How much of it the part being read needs before a frame can be cut from it: its header
  // and the length its header names, or nothing while its header has not all arrived.
  let need = 0;
  const end = (error?: Error): void => {
    if (closed) return;
    closed = true;
    onEnd(error);
  };
  const req = request(url, (res) => {
    if (res.statusCode !== 200) {
      res.resume();
      end(new Error(`the frame stream answered ${res.statusCode}`));
      return;
    }
    res.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      // A JPEG arrives in many chunks, which are joined once it has all arrived, not as each comes.
      if (size < need) return;
      let pending = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size);
      need = 0;
      // Each part is a header block, ending in a blank line, and a JPEG of the length it
      // names. A block that names none, such as the blank lines between parts, is skipped.
      for (;;) {
        const head = pending.indexOf(HEADER_END);
        if (head === -1) break;
        const length = Number(/content-length:\s*(\d+)/i.exec(pending.subarray(0, head).toString('latin1'))?.[1] ?? NaN);
        if (!Number.isFinite(length)) {
          pending = pending.subarray(head + HEADER_END.length);
          continue;
        }
        const start = head + HEADER_END.length;
        if (pending.length < start + length) {
          need = start + length;
          break;
        }
        const jpeg = Buffer.from(pending.subarray(start, start + length));
        pending = pending.subarray(start + length);
        if (!closed) onFrame(jpeg);
      }
      chunks = pending.length ? [pending] : [];
      size = pending.length;
    });
    res.on('end', () => end());
    res.on('error', (e) => end(e));
  });
  req.on('error', (e) => end(e));
  req.end();
  return {
    close() {
      closed = true;
      req.destroy();
    },
  };
}
