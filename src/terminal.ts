// The terminal surface. A demo script that declares `**Terminal:**` drives a bash session
// in a terminal the engine serves itself, where a page script drives an app.
//
// The terminal is xterm.js, in a page this module writes into the capture's browser
// page, and the shell runs in a pseudo-terminal (pty) from @lydell/node-pty. What the
// shell prints is handed to xterm unread. What a step types goes to xterm's own input,
// so xterm encodes each key for the terminal's current modes and the bytes go to the pty.
// The engine parses no escape sequence: every read of terminal state (the screen's text,
// a row, the cursor, the last exit status) goes through xterm's buffer API, in the page,
// where the step runner's proofs read it.
//
// The shell's prompt carries semantic-prompt marks (OSC 133). xterm hands each one to a
// handler registered here, so the page knows when a prompt shows and the exit status of
// the command that finished before it. `run` waits on the prompt, and an `exit`
// assertion reads the status.
//
// specs/ss-71qt/design.md records why the surface is built this way.

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import type { IPty } from '@lydell/node-pty';
import { errors, type Page } from 'playwright';

import type { Assertion, Matcher, PressKey, TerminalSpec } from './demo-script.ts';
import { esc, ACCENT, ACCENT_FAIL, BG, FG, MUTED, FONT } from './overlay.ts';

/** The window a still captures: the title bar and the terminal below it. */
export const TERMINAL_WINDOW = '#ss-window';

/**
 * The shell's prompt: `$ `, behind the marks that report the last command's exit status
 * (D), and where the prompt starts (A) and ends (B). `\[ \]` tells bash the marks take no
 * room on the line.
 */
const PROMPT = '\\[\\e]133;D;$?\\a\\e]133;A\\a\\]$ \\[\\e]133;B\\a\\]';

/** Variables that describe the terminal the engine runs in, which the shell's programs must not take for theirs. */
const FOREIGN_TERMINAL_VARS = [
  'COLUMNS',
  'LINES',
  'TMUX',
  'TMUX_PANE',
  'STY',
  'TERM_PROGRAM',
  'TERM_PROGRAM_VERSION',
  'TERM_SESSION_ID',
  'ITERM_SESSION_ID',
  'ITERM_PROFILE',
  'LC_TERMINAL',
  'LC_TERMINAL_VERSION',
  'KITTY_WINDOW_ID',
  'WEZTERM_PANE',
  'WT_SESSION',
  'VTE_VERSION',
  'ALACRITTY_WINDOW_ID',
  'COLORFGBG',
];

/** Variables that would change the session's prompt, its line editing, or what bash runs at start. */
const SHELL_STATE_VARS = ['PROMPT_COMMAND', 'PS0', 'PS2', 'SHELLOPTS', 'BASHOPTS', 'BASH_ENV', 'ENV'];

/** The font sizes the terminal is drawn at: the largest at which the window fits the stage. */
const FONT_SIZES = { max: 24, min: 1 };
/** The stage the window is fitted to: the viewport less a margin all round and the caption bar's band at the bottom. */
const STAGE = { margin: 24, band: 72 };
const WINDOW = { titlebar: 32, padX: 14, padY: 12 };
const MONO = 'Menlo, Monaco, "DejaVu Sans Mono", "Liberation Mono", "Ubuntu Mono", Consolas, monospace';
/** Lines the terminal keeps above the screen; `--full-page` captures at most these and the screen. */
const SCROLLBACK = 1000;
/** No output for this long, and the terminal has caught up with the shell. */
const QUIET_MS = 120;
/** A program that never goes quiet, such as a spinner, is framed after this long. */
const SETTLE_CAP_MS = 2000;
/** How long the shell's session has to end after SIGHUP, before what is left of it gets SIGKILL. */
const KILL_GRACE_MS = 2000;
/**
 * How long SIGKILL has to end what is left of the session. A process outlasts it only when
 * the kernel holds it, and the engine then names its group and stops waiting.
 */
const KILL_WAIT_MS = 30_000;

/** The xterm theme: the engine's card colours, with an ANSI palette in the same key. */
const THEME = {
  background: BG,
  foreground: FG,
  cursor: FG,
  cursorAccent: BG,
  selectionBackground: '#3a4252',
  black: '#1b1e25',
  red: ACCENT_FAIL,
  green: ACCENT,
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ff7a72',
  brightGreen: '#8ee4a8',
  brightYellow: '#f0d197',
  brightBlue: '#82c4ff',
  brightMagenta: '#d99cf0',
  brightCyan: '#7fd3dd',
  brightWhite: '#ffffff',
  // xterm refuses a colour name that draws transparent, such as `transparent`, and falls
  // back to its grey slider; a hex colour with zero alpha is taken as written.
  scrollbarSliderBackground: '#00000000',
  scrollbarSliderHoverBackground: '#00000000',
  scrollbarSliderActiveBackground: '#00000000',
};

const PAGE_CSS =
  'html,body{margin:0}' +
  `body.ss-backdrop{box-sizing:border-box;height:100vh;padding:${STAGE.margin}px ${STAGE.margin}px ${STAGE.margin + STAGE.band}px;` +
  'display:flex;align-items:center;justify-content:center;background:radial-gradient(ellipse at 50% 30%,#262b36 0%,#0b0d12 72%)}' +
  `#ss-window{display:inline-block;vertical-align:top;border-radius:10px;overflow:hidden;background:${BG}}` +
  'body.ss-backdrop #ss-window{box-shadow:0 24px 60px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.07)}' +
  `#ss-titlebar{position:relative;height:${WINDOW.titlebar}px;display:flex;align-items:center;justify-content:center;` +
  `background:#1a1d24;box-shadow:inset 0 -1px rgba(255,255,255,.06);color:${MUTED};font:13px/1 ${FONT}}` +
  `#ss-dots{position:absolute;left:14px;top:${(WINDOW.titlebar - 12) / 2}px;display:flex;gap:8px}` +
  '#ss-dots i{display:block;width:12px;height:12px;border-radius:50%}' +
  '#ss-title{max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
  `#ss-terminal{padding:${WINDOW.padY}px ${WINDOW.padX}px}`;

/** The terminal page: a window with a title bar, whose terminal installTerminal draws. */
function terminalDocument(title: string, backdrop: boolean): string {
  const dots = ['#ff5f57', '#febc2e', '#28c840'].map((c) => `<i style="background:${c}"></i>`).join('');
  return (
    `<!doctype html><html><head><meta charset="utf-8"><style>${PAGE_CSS}</style></head>` +
    `<body${backdrop ? ' class="ss-backdrop"' : ''}><div id="ss-window">` +
    `<div id="ss-titlebar"><span id="ss-dots">${dots}</span><span id="ss-title">${esc(title)}</span></div>` +
    '<div id="ss-terminal"></div></div></body></html>'
  );
}

const requireHere = createRequire(import.meta.url);
let xterm: { js: string; css: string } | null = null;

/** xterm.js's bundle and stylesheet, read once from the installed package. */
function xtermAssets(): { js: string; css: string } {
  xterm ??= {
    js: readFileSync(requireHere.resolve('@xterm/xterm/lib/xterm.js'), 'utf8'),
    css: readFileSync(requireHere.resolve('@xterm/xterm/css/xterm.css'), 'utf8'),
  };
  return xterm;
}

/** What the terminal page knows about its shell. */
export interface TerminalState {
  /** Prompts the shell has shown. */
  prompts: number;
  /** Input was submitted with an Enter key since the last prompt, so a command is running. */
  submitted: boolean;
  /**
   * The exit status of the last command the shell finished, or the shell's own once it has
   * exited. Null while a command runs, and before the first one.
   */
  status: number | null;
  /** The shell has exited. */
  ended: boolean;
  /** A full-screen program holds the alternate screen. */
  alternate: boolean;
}

/** The terminal page's API, `window.__ss_term`. */
interface PageTerminal {
  /** Hand xterm output from the pty; resolves once xterm has parsed it. */
  write(data: string): Promise<void>;
  /** Record that the shell exited with `status`. */
  ended(status: number): void;
  state(): TerminalState;
  screen(): string;
  row(n: number): string | null;
  cursor(): { row: number; col: number; rows: number };
  focus(): void;
  /** Give the terminal one row for each line of the session, so the window holds all of it. Returns the rows. */
  expand(): number;
  /** Resolve once the browser has drawn what xterm rendered. */
  painted(): Promise<void>;
}

type TermWindow = { __ss_term: PageTerminal };

interface InstallOptions {
  cols: number;
  rows: number;
  fontFamily: string;
  fontSizes: { max: number; min: number };
  stage: { margin: number; band: number };
  window: { titlebar: number; padX: number; padY: number };
  scrollback: number;
  theme: Record<string, string>;
  inputBinding: string;
}

/**
 * Runs in the page: create the terminal, fit its font to the stage, keep the state the
 * prompt's marks report, and expose `window.__ss_term`. Returns whether the window fits
 * the stage, which it does at some font size for every size the parser accepts at the
 * drivers' viewport.
 *
 * A screen is what the terminal displays now: the last `rows` lines of the buffer on the
 * normal screen, or the alternate screen while a full-screen program holds it.
 */
function installTerminal(o: InstallOptions): boolean {
  const w = window as unknown as Record<string, any>;
  const term = new w.Terminal({ cols: o.cols, rows: o.rows, fontFamily: o.fontFamily, fontSize: o.fontSizes.max, scrollback: o.scrollback, cursorBlink: false, theme: o.theme });
  term.open(document.getElementById('ss-terminal'));

  // The largest font at which the window fits the stage. The window grows with the font,
  // so the first size down that fits is the largest.
  const fits = (): boolean => {
    const box = (term.element.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
    const width = box.width + 2 * o.window.padX;
    const height = box.height + 2 * o.window.padY + o.window.titlebar;
    return width <= innerWidth - 2 * o.stage.margin && height <= innerHeight - 2 * o.stage.margin - o.stage.band;
  };
  let size = o.fontSizes.max;
  while (size > o.fontSizes.min && !fits()) {
    size -= 1;
    term.options.fontSize = size;
  }

  const st = { prompts: 0, submitted: false, status: null as number | null, ended: false };
  term.parser.registerOscHandler(133, (data: string) => {
    const [mark, arg] = data.split(';');
    if (mark === 'D' && st.submitted && /^\d+$/.test(arg ?? '')) st.status = Number(arg);
    if (mark === 'A') {
      st.prompts += 1;
      st.submitted = false;
    }
    return true;
  });
  term.onData((data: string) => {
    if (!st.ended && /[\r\n]/.test(data)) {
      st.submitted = true;
      st.status = null;
    }
    Promise.resolve(w[o.inputBinding](data)).catch(() => {});
  });

  const buf = (): any => term.buffer.active;
  // xterm's own trim drops only cells nothing wrote to, so blanks a program wrote, such
  // as a status bar's padding, are dropped here.
  const text = (y: number, trim: boolean): string => {
    const line: string = buf().getLine(y)?.translateToString(trim) ?? '';
    return trim ? line.replace(/ +$/, '') : line;
  };
  const api: PageTerminal = {
    write: (data) => new Promise<void>((resolve) => term.write(data, resolve)),
    ended(status) {
      st.ended = true;
      st.submitted = false;
      st.status = status;
    },
    state: () => ({ ...st, alternate: buf().type === 'alternate' }),
    screen() {
      // A row the terminal wrapped onto the next keeps its full width and joins it with
      // no line break; every other row loses its trailing blanks and ends the line.
      const b = buf();
      let out = '';
      for (let y = 0; y < term.rows; y++) {
        const joins = y + 1 < term.rows && Boolean(b.getLine(b.baseY + y + 1)?.isWrapped);
        out += text(b.baseY + y, !joins) + (joins || y + 1 === term.rows ? '' : '\n');
      }
      return out;
    },
    row(n) {
      const y = n > 0 ? n - 1 : term.rows + n;
      return y >= 0 && y < term.rows ? text(buf().baseY + y, true) : null;
    },
    // A cursor parked after the last column (a pending wrap) shows on the last column.
    cursor: () => ({ row: buf().cursorY + 1, col: Math.min(buf().cursorX, term.cols - 1) + 1, rows: term.rows }),
    focus: () => term.focus(),
    expand() {
      // From the scrollback's first line to the last line with text or the cursor's,
      // whichever is lower. The alternate screen has no scrollback and stays as it is.
      const b = buf();
      if (b.type !== 'normal') return term.rows;
      let last = b.baseY + b.cursorY;
      for (let y = b.length - 1; y > last; y--) {
        if (text(y, true)) {
          last = y;
          break;
        }
      }
      if (last + 1 !== term.rows) term.resize(term.cols, last + 1);
      // A taller terminal takes its new rows from the scrollback only while the cursor is
      // on the bottom row. Below a cleared screen it adds blank rows instead, so the window
      // is scrolled to the buffer's first line, where the session starts either way.
      term.scrollToTop();
      return last + 1;
    },
    painted: () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  };
  w.__ss_term = api;
  return fits();
}

/**
 * The directory a terminal script's shell starts in: `cwd` resolved, or the working
 * directory. Throws when it is not a directory, before anything is started.
 */
export function shellDir(cwd?: string): string {
  const dir = path.resolve(cwd ?? process.cwd());
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new Error(`terminal: the shell cannot start in ${dir}, which is not a directory`);
  return dir;
}

/**
 * The shell's environment: the engine's own, less what describes another terminal or
 * would change the prompt and line editing, plus the terminal's type, the marked prompt,
 * no history file, no inputrc, and a UTF-8 locale when none is named.
 */
export function shellEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  for (const k of [...FOREIGN_TERMINAL_VARS, ...SHELL_STATE_VARS]) delete env[k];
  Object.assign(env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PS1: PROMPT,
    HISTFILE: '/dev/null',
    INPUTRC: '/dev/null',
    BASH_SILENCE_DEPRECATION_WARNING: '1',
  });
  if (!env.LANG && !env.LC_ALL && !env.LC_CTYPE) env.LANG = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return env;
}

type PtyModule = typeof import('@lydell/node-pty');

/** node-pty, loaded only when a terminal script runs, so a page capture never loads a native module. */
async function loadPty(): Promise<PtyModule> {
  try {
    return await import('@lydell/node-pty');
  } catch (e) {
    throw new Error(
      `terminal: no pty on this host (${process.platform}-${process.arch}); @lydell/node-pty has binaries for macOS and Linux on x64 and arm64: ${(e as Error).message.split('\n')[0]}`,
    );
  }
}

export interface TerminalOptions {
  spec: TerminalSpec;
  /** The window's title. */
  title: string;
  /** The directory the shell starts in (default: the working directory). */
  cwd?: string;
  /**
   * Frame the window on a dark backdrop above the caption band, as the videos show it. A
   * still leaves the page around the window unpainted.
   */
  backdrop: boolean;
  /** How long to wait for the shell's first prompt. */
  readyTimeout: number;
  log: (m: string) => void;
}

export interface TerminalSession {
  /** Wait until the terminal has drawn everything the shell has printed. */
  settle(): Promise<void>;
  /**
   * End the shell and every job it runs (see endSession). Resolves once they have all
   * exited, or once the log names a group that SIGKILL did not end.
   */
  close(): Promise<void>;
}

const INPUT_BINDING = '__ss_term_input';
/** The pages that have the input binding; Playwright registers a binding once per page. */
const bound = new WeakSet<Page>();
/** Where each page's terminal input goes: the pty of the session open in it. */
const inputs = new WeakMap<Page, (data: string) => void>();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const execFileP = promisify(execFile);

/** Check `done` every 25 ms until it holds or `ms` has passed. Resolves whether it held. */
async function until(done: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (done()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(25);
  }
}

/**
 * The process groups of the session the shell leads: the shell's own, and one for each job
 * it started, which holds whatever that job started in turn. They are read while the shell
 * runs, which keeps each id in use by this session.
 *
 * Linux lists the session by its id, in /proc. A macOS process listing shows no session
 * id, so there the session is read as the processes whose controlling terminal is the
 * shell's, which are the session's for as long as the shell runs. `ps` gives each one's
 * terminal as a device number: naming the terminal costs a lookup for each process on the
 * host, and takes seconds on a busy one.
 *
 * The listing has no deadline. Nothing races it, since the shell runs until it is hung
 * up, and a listing cut short would leave only the shell to end.
 */
async function sessionGroups(shell: number): Promise<number[]> {
  const groups = new Set([shell]);
  if (process.platform === 'linux') {
    for (const pid of readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      let stat: string;
      try {
        stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        continue; // it exited while the list was read
      }
      // `pid (comm) state ppid pgrp session …`, where comm can hold spaces and parentheses.
      const [, , pgrp, session] = stat.slice(stat.lastIndexOf(')') + 2).split(' ').map(Number);
      if (session === shell) groups.add(pgrp);
    }
  } else {
    const { stdout } = await execFileP('ps', ['-A', '-o', 'pid=,pgid=,tdev=']);
    const procs = stdout.trim().split('\n').map((line) => line.trim().split(/\s+/));
    const tdev = procs.find(([pid]) => Number(pid) === shell)?.[2];
    if (tdev && !tdev.startsWith('?')) for (const [, pgid, t] of procs) if (t === tdev) groups.add(Number(pgid));
  }
  // Never 0 or 1: kill(-0) signals the engine's own group, and kill(-1) every process it may signal.
  return [...groups].filter((g) => Number.isSafeInteger(g) && g > 1);
}

/** Whether a process group still holds a process the engine may signal. */
function groupRuns(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End the session the shell leads, the shell and every job it runs. Each of its process
 * groups gets SIGHUP. Any of them still running KILL_GRACE_MS later gets SIGKILL, whether
 * that is the shell or a job that outlived it, such as a program that handles SIGHUP.
 * Resolves once every group has ended and node-pty has seen the shell exit. A group that
 * SIGKILL has not ended within KILL_WAIT_MS is named in the log and left running.
 *
 * The groups are read before the hang-up, because once the shell has exited nothing ties
 * its jobs to the terminal, and SIGHUP is what makes it exit. `shellExited` reports
 * whether node-pty has seen the shell exit.
 */
async function endSession(shell: number, shellExited: () => boolean, log: (m: string) => void): Promise<void> {
  const groups = await sessionGroups(shell).catch((e: Error) => {
    log(`terminal: could not list the shell's jobs, so only the shell is ended: ${e.message.split('\n')[0]}`);
    return [shell];
  });
  const signal = (targets: number[], sig: NodeJS.Signals): void => {
    for (const g of targets) {
      try {
        process.kill(-g, sig);
      } catch {
        /* the group has ended */
      }
    }
  };
  const ended = (): boolean => shellExited() && !groups.some(groupRuns);
  signal(groups, 'SIGHUP');
  if (await until(ended, KILL_GRACE_MS)) return;
  signal(groups.filter(groupRuns), 'SIGKILL');
  if (await until(ended, KILL_WAIT_MS)) return;
  const left = groups.filter(groupRuns);
  if (left.length) log(`terminal: SIGKILL did not end the shell's session within ${KILL_WAIT_MS / 1000}s, so it is left running in process group${left.length > 1 ? 's' : ''} ${left.join(', ')}`);
}

/**
 * Write the terminal page into `page`, start bash in a pty of the script's size, and wait
 * for its first prompt. The page shows the session until it is closed.
 */
export async function openTerminal(page: Page, o: TerminalOptions): Promise<TerminalSession> {
  const cwd = shellDir(o.cwd);
  const pty = await loadPty();
  const { js, css } = xtermAssets();
  if (!bound.has(page)) {
    await page.exposeBinding(INPUT_BINDING, (_source, data: string) => inputs.get(page)?.(data));
    bound.add(page);
  }
  await page.setContent(terminalDocument(o.title, o.backdrop));
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: js });
  const install: InstallOptions = {
    cols: o.spec.cols,
    rows: o.spec.rows,
    fontFamily: MONO,
    fontSizes: FONT_SIZES,
    stage: STAGE,
    window: WINDOW,
    scrollback: SCROLLBACK,
    theme: THEME,
    inputBinding: INPUT_BINDING,
  };
  if (!(await page.evaluate(installTerminal, install))) {
    const [width, height] = await page.evaluate(() => [innerWidth, innerHeight]);
    throw new Error(`terminal: a ${o.spec.cols}x${o.spec.rows} terminal does not fit a ${width}x${height} page even at ${FONT_SIZES.min} px`);
  }

  let child: IPty;
  try {
    child = pty.spawn('bash', ['--noprofile', '--norc'], { name: 'xterm-256color', cols: o.spec.cols, rows: o.spec.rows, cwd, env: shellEnv() });
  } catch (e) {
    throw new Error(`terminal: cannot start bash: ${(e as Error).message}`);
  }

  // The pty's output goes to the page in the order it arrived. Output that arrives while
  // a hand-off is in flight waits for it and goes in the next one. The page is told the
  // shell exited only after all of its output. node-pty drops output that no listener
  // takes, so the listeners below attach in the same tick as the spawn, with no await
  // between them, or the first prompt can be lost.
  let pending = '';
  let pumping: Promise<void> | null = null;
  let detached = false;
  let lastOutput = Date.now();
  let exit: { status: number; told: boolean } | null = null;
  const pump = (): void => {
    if (pumping || detached) return;
    pumping = (async () => {
      for (;;) {
        if (detached) return;
        if (pending) {
          const data = pending;
          pending = '';
          await page.evaluate((d) => (window as unknown as TermWindow).__ss_term.write(d), data);
        } else if (exit && !exit.told) {
          exit.told = true;
          await page.evaluate((s) => (window as unknown as TermWindow).__ss_term.ended(s), exit.status);
        } else {
          return;
        }
      }
    })()
      .catch(() => {
        // The page closed or moved on, so nothing shows this session any more.
        detached = true;
      })
      .finally(() => {
        pumping = null;
      });
  };
  child.onData((data) => {
    pending += data;
    lastOutput = Date.now();
    pump();
  });
  child.onExit(({ exitCode, signal }) => {
    exit = { status: signal ? 128 + signal : exitCode, told: false };
    pump();
  });
  inputs.set(page, (data) => {
    if (!exit && !detached) child.write(data);
  });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      inputs.delete(page);
      detached = true;
      // A shell that has exited leads no session, so nothing ties a job it left running
      // to this terminal any more, and there is nothing to end.
      if (!exit) await endSession(child.pid, () => exit !== null, o.log);
      await pumping;
    })();
    return closing;
  };

  const state = (): Promise<TerminalState> => page.evaluate(() => (window as unknown as TermWindow).__ss_term.state());
  try {
    await page
      .waitForFunction(
        () => {
          const s = (window as unknown as TermWindow).__ss_term.state();
          return s.prompts > 0 || s.ended;
        },
        null,
        { timeout: o.readyTimeout, polling: 50 },
      )
      .catch(() => {});
    const s = await state();
    if (s.prompts === 0) {
      const shown = (await page.evaluate(() => (window as unknown as TermWindow).__ss_term.screen())).trim().split('\n').slice(-3).join(' / ');
      const what = s.ended ? `exited with status ${s.status} before its first prompt; a terminal script needs bash on PATH` : `showed no prompt within ${o.readyTimeout / 1000}s`;
      throw new Error(`terminal: bash ${what}${shown ? `; the screen shows: ${shown}` : ''}`);
    }
    await page.evaluate(() => (window as unknown as TermWindow).__ss_term.focus());
  } catch (e) {
    await close();
    throw e;
  }
  o.log(`terminal: bash in ${cwd} · ${o.spec.cols}x${o.spec.rows}`);

  return {
    async settle() {
      const deadline = Date.now() + SETTLE_CAP_MS;
      while (!detached && Date.now() < deadline && (pending || pumping || Date.now() - lastOutput < QUIET_MS)) await sleep(20);
      if (!detached) await page.evaluate(() => (window as unknown as TermWindow).__ss_term.painted()).catch(() => {});
    },
    close,
  };
}

/** The terminal page's API, or an error naming that the page has none. */
async function requireTerminal(page: Page): Promise<void> {
  if (!(await page.evaluate(() => Boolean((window as unknown as Partial<TermWindow>).__ss_term)))) throw new Error('this page has no terminal');
}

/** What the page's terminal knows about its shell now. */
export async function terminalState(page: Page): Promise<TerminalState> {
  await requireTerminal(page);
  return page.evaluate(() => (window as unknown as TermWindow).__ss_term.state());
}

export interface RunPace {
  /** Milliseconds between typed characters. */
  typeDelay: number;
  /** How long to wait for the shell's prompt before typing. */
  promptTimeout: number;
  /** How long to wait for the command to settle once it is submitted. */
  commandTimeout: number;
  /** A pause once the command settles, so its output reads in a recording. */
  pause: number;
}

/**
 * `run <command line>`: wait for the shell's prompt, type the line and press Enter, then
 * wait until the command finishes (the next prompt shows), a full-screen program takes
 * over the alternate screen, or the shell exits. Logs how it settled.
 *
 * A program that waits for input on the normal screen, such as a REPL or a `read`
 * prompt, does none of these, so the wait runs out. The error then names the way to
 * drive one: `press` to start it, and `waitForScreen` for its prompt.
 */
export async function terminalRun(page: Page, command: string, pace: RunPace, log: (m: string) => void): Promise<void> {
  await requireTerminal(page);
  await page.waitForFunction(
    () => {
      const s = (window as unknown as TermWindow).__ss_term.state();
      return (s.prompts > 0 && !s.submitted) || s.ended;
    },
    null,
    { timeout: pace.promptTimeout, polling: 50 },
  );
  const before = await terminalState(page);
  if (before.ended) throw new Error(`the shell has exited (status ${before.status})`);
  await page.evaluate(() => (window as unknown as TermWindow).__ss_term.focus());
  await page.keyboard.type(command, { delay: pace.typeDelay });
  await page.keyboard.press('Enter');
  try {
    await page.waitForFunction(
      (prompts) => {
        const s = (window as unknown as TermWindow).__ss_term.state();
        return s.prompts > prompts || s.alternate || s.ended;
      },
      before.prompts,
      { timeout: pace.commandTimeout, polling: 50 },
    );
  } catch (e) {
    if (!(e instanceof errors.TimeoutError)) throw e;
    throw new Error(
      `\`${command}\` showed no prompt within ${pace.commandTimeout / 1000}s; for an interactive program on the normal screen, use \`press "${command}" Enter\` and \`waitForScreen\``,
    );
  }
  const after = await terminalState(page);
  if (after.prompts > before.prompts) log(`  · \`${command}\` exited ${after.status}`);
  else if (after.ended) log(`  · the shell exited ${after.status}`);
  else log(`  · \`${command}\` took over the screen`);
  if (pace.pause > 0) await page.waitForTimeout(pace.pause);
}

export interface PressPace {
  /** Milliseconds between typed characters. */
  typeDelay: number;
  /** A pause between keys, so a recording shows each one land. */
  keyPause: number;
  /** A pause after the last key, so its effect reads in a recording. */
  pause: number;
}

/** `press <keys>`: press each key in turn, or type a quoted key's text. It waits for nothing the keys cause. */
export async function terminalPress(page: Page, keys: PressKey[], pace: PressPace): Promise<void> {
  await requireTerminal(page);
  await page.evaluate(() => (window as unknown as TermWindow).__ss_term.focus());
  for (const [i, k] of keys.entries()) {
    if ('text' in k) await page.keyboard.type(k.text, { delay: pace.typeDelay });
    else await page.keyboard.press(k.key);
    const pause = i + 1 < keys.length ? pace.keyPause : pace.pause;
    if (pause > 0) await page.waitForTimeout(pause);
  }
}

/** `waitForScreen <matcher>`: wait until the screen's text matches. */
export async function terminalWaitForScreen(page: Page, matcher: Matcher, timeout: number): Promise<void> {
  await requireTerminal(page);
  await page.waitForFunction(
    (m) => {
      const text = (window as unknown as TermWindow).__ss_term.screen();
      return m.type === 'regex' ? new RegExp(m.value, 'm').test(text) : text.includes(m.value);
    },
    matcher,
    { timeout, polling: 100 },
  );
}

/**
 * Check a terminal assertion against the page's terminal once: `screen`, `row`, `cursor`
 * or `exit`. A regex matcher is tested with the `m` flag, so `^` and `$` match at each
 * row's start and end. An `exit` assertion holds only while the shell reports a status.
 */
export async function checkTerminalAssertion(page: Page, a: Assertion): Promise<boolean> {
  return page.evaluate((a) => {
    const t = (window as unknown as TermWindow).__ss_term;
    const matches = (text: string, m: Matcher | undefined): boolean => (m?.type === 'regex' ? new RegExp(m.value, 'm').test(text) : text.includes(m?.value ?? ''));
    switch (a.kind) {
      case 'screen':
        return matches(t.screen(), a.matcher);
      case 'row': {
        const row = t.row(a.row ?? 0);
        return row !== null && matches(row, a.matcher);
      }
      case 'cursor': {
        const c = t.cursor();
        const row = (a.row ?? 0) > 0 ? a.row : c.rows + (a.row ?? 0) + 1;
        return c.row === row && c.col === a.col;
      }
      case 'exit': {
        const s = t.state().status;
        if (s === null) return false;
        const n = a.n ?? 0;
        switch (a.op) {
          case '>=': return s >= n;
          case '>': return s > n;
          case '==': return s === n;
          case '<=': return s <= n;
          case '<': return s < n;
          default: return false;
        }
      }
      default:
        return false;
    }
  }, a);
}

/** Give the page's terminal one row for each line of the session, and wait for it to be drawn. */
export async function expandToSession(page: Page): Promise<void> {
  await requireTerminal(page);
  await page.evaluate(() => (window as unknown as TermWindow).__ss_term.expand());
  await page.evaluate(() => (window as unknown as TermWindow).__ss_term.painted());
}
