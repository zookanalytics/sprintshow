// A stand-in for Appium and the iOS app it drives, for the tests that run with neither a
// simulator nor Appium, as on CI's Linux runners. One HTTP server answers the WebDriver
// commands the engine sends an iOS app, as Appium answers them, for a sprint board like
// examples/sample-ios, and streams frames of the board's screen as WebDriverAgent does,
// as MJPEG. It records each command it is sent. A test can end the streams of frames, or
// hold their frames back while the streams stay open.
//
// The board has a field, new-task, an Add button, add, a hint, empty-hint, shown only
// while there is no task, a task element for each task, named task, whose label is its
// title and whose value is its state, and a summary, whose label counts the tasks and the
// done ones. Typing into the field and tapping Add, or typing a Return, adds a task, and
// tapping a task toggles it.

import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

/** The key a W3C element reference is sent under. */
export const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export interface Board {
  field: string;
  tasks: { title: string; done: boolean }[];
}

export interface StandIn {
  /** The stand-in Appium's base URL. */
  url: string;
  /** The URL of the stream of the screen's frames. */
  frames: string;
  /** Each command it was sent, as `METHOD /route`, and its body when it had one, such as `POST /element/add/click {}`. */
  commands: string[];
  board: Board;
  /** The screen, in points. */
  screen: { width: number; height: number };
  /** End every stream of the screen's frames, as a connection that drops does, while the commands go on being answered. */
  endFrames(): void;
  /** Send no more frames, and leave every stream open, as WebDriverAgent does while it takes no screenshot. */
  holdFrames(): void;
  close(): Promise<void>;
}

export interface StandInOptions {
  /** The JPEG of the screen the board shows. */
  frame: (board: Board) => Buffer;
  /** The PNG the screenshot command answers with. */
  screenshot: Buffer;
  /** Frames a second. */
  fps?: number;
}

/** Where each element lies on the 400x800-point screen. */
const RECTS: Record<string, { x: number; y: number; width: number; height: number }> = {
  'new-task': { x: 16, y: 120, width: 280, height: 44 },
  add: { x: 310, y: 120, width: 74, height: 44 },
  'empty-hint': { x: 16, y: 190, width: 368, height: 44 },
  summary: { x: 32, y: 600, width: 200, height: 20 },
};

export async function standInAppium(opts: StandInOptions): Promise<StandIn> {
  const board: Board = { field: '', tasks: [] };
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const streams = new Set<ServerResponse>();

  const exists = (id: string): boolean => (id === 'empty-hint' ? board.tasks.length === 0 : id.startsWith('task-') ? Number(id.slice(5)) < board.tasks.length : id in RECTS);
  const label = (id: string): string | null => {
    if (id === 'summary') return `${board.tasks.length} tasks · ${board.tasks.filter((t) => t.done).length} done`;
    if (id === 'empty-hint') return 'No tasks yet — add one to get started.';
    if (id === 'add') return 'Add';
    if (id.startsWith('task-')) return board.tasks[Number(id.slice(5))].title;
    return '';
  };
  const value = (id: string): string | null => (id === 'new-task' ? board.field || 'Add a task…' : id.startsWith('task-') ? (board.tasks[Number(id.slice(5))].done ? 'done' : 'to do') : null);
  const rect = (id: string): { x: number; y: number; width: number; height: number } => RECTS[id] ?? { x: 16, y: 250 + 50 * Number(id.slice(5)), width: 368, height: 44 };
  /** The elements `name` names: by identifier, or a task by its title. */
  const named = (name: string): string[] => {
    if (name === 'task') return board.tasks.map((_, i) => `task-${i}`);
    const byTitle = board.tasks.findIndex((t) => t.title === name);
    if (byTitle >= 0) return [`task-${byTitle}`];
    return exists(name) ? [name] : [];
  };
  const add = (): void => {
    if (board.field.trim()) board.tasks.push({ title: board.field.trim(), done: false });
    board.field = '';
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const route = (req.url ?? '/').replace(/^\/session\/s1/, '');
      const answer = (v: unknown, status = 200): void => {
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ value: v }));
      };
      const noSuch = (): void => answer({ error: 'no such element', message: 'An element could not be located\nwith the given strategy' }, 404);
      if (req.url === '/mjpeg') {
        res.writeHead(200, { 'content-type': 'multipart/x-mixed-replace; boundary=--BoundaryString' });
        streams.add(res);
        res.on('close', () => streams.delete(res));
        return;
      }
      commands.push(`${req.method} ${route}${body ? ` ${body}` : ''}`);
      const json = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (req.method === 'POST' && req.url === '/session') return answer({ sessionId: 's1', capabilities: json });
      if (req.method === 'DELETE' && route === '') return answer(null);
      if (route === '/window/rect') return answer({ x: 0, y: 0, width: 400, height: 800 });
      if (route === '/screenshot') return answer(opts.screenshot.toString('base64'));
      if (route === '/element' || route === '/elements') {
        const ids = named(String(json.value));
        if (route === '/elements') return answer(ids.map((id) => ({ [ELEMENT]: id })));
        return ids.length ? answer({ [ELEMENT]: ids[0] }) : noSuch();
      }
      if (route === '/keys') {
        for (const ch of (json.value as string[]).join('')) {
          if (ch === '\n') add();
          else board.field += ch;
        }
        return answer(null);
      }
      if (route === '/execute/sync') return answer(null);
      if (route === '/appium/settings') return answer(null);
      const el = route.match(/^\/element\/([^/]+)\/(click|clear|value|displayed|rect|attribute\/(\w+))$/);
      if (el) {
        const [, id, what, attr] = el;
        if (!exists(id)) return answer({ error: 'stale element reference', message: 'The element is gone' }, 404);
        if (what === 'click') {
          if (id === 'add') add();
          if (id.startsWith('task-')) board.tasks[Number(id.slice(5))].done = !board.tasks[Number(id.slice(5))].done;
          return answer(null);
        }
        if (what === 'clear') {
          board.field = '';
          return answer(null);
        }
        if (what === 'value') {
          board.field += String(json.text);
          return answer(null);
        }
        if (what === 'displayed') return answer(true);
        if (what === 'rect') return answer(rect(id));
        return answer(attr === 'label' ? label(id) : attr === 'value' ? value(id) : null);
      }
      answer({ error: 'unknown command', message: `the stand-in has no ${req.method} ${route}` }, 404);
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let held = false;
  const timer = setInterval(() => {
    if (held) return;
    const jpeg = opts.frame(board);
    for (const res of streams) {
      res.write(`--BoundaryString\r\nContent-type: image/jpg\r\nContent-Length: ${jpeg.length}\r\n\r\n`);
      res.write(jpeg);
      res.write('\r\n\r\n');
    }
  }, 1000 / (opts.fps ?? 25));

  return {
    url: base,
    frames: `${base}/mjpeg`,
    commands,
    board,
    screen: { width: 400, height: 800 },
    endFrames() {
      for (const res of streams) res.end();
    },
    holdFrames() {
      held = true;
    },
    async close() {
      clearInterval(timer);
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
