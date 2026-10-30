// Tests for the terminal surface (src/terminal.ts): a script that declares `**Terminal:**`
// drives bash in a pty, attached to xterm.js in a page the engine writes, through the
// step runner the page captures use.
//
// They pin what a proof reads: `run` waits for its command and reports its exit status,
// no `exit` assertion holds while a command runs, the screen joins a row the terminal
// wrapped, and rows and the cursor count from the top or the bottom. A `run` whose wait
// runs out names `press` and `waitForScreen`, which drive a program that waits for input
// on the normal screen. They pin that xterm
// encodes each key for the terminal's cursor-key mode, that a full-screen program's
// alternate screen, cursor addressing and colours are drawn as it sent them, and that
// quitting it restores the shell's screen. They pin the captures: the still is the
// terminal window with transparent corners, `--full-page` holds the whole session, or
// its last lines, each one drawn in tiles of either size Chromium draws in, when the
// session is more than one capture holds. A full-page still saves nothing, and says why,
// at a scale where one capture cannot hold a line of the session, or when the page has
// no terminal window. A terminal script refuses a server, a selector, or a directory that
// does not exist before a browser is spent. A video frame
// shows every cell of a terminal at each limit of the sizes the parser accepts, clear of
// the caption bar. The shell and every program it still runs end before the capture
// returns, even a program that handles SIGHUP and however slowly the host lists them, and
// the walkthrough ends them only once its recording is flushed. The shell inherits the
// engine's environment less the Vercel bypass key, which only the engine uses, and the
// variables that describe another terminal. OPENAI_API_KEY reaches it.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, parseAssertion, parseKeys, parseMatcher, TERMINAL_COLS, TERMINAL_ROWS, type Assertion, type Demo } from '../src/demo-script.ts';
import { openSurface, runStep, runAction, checkAssertion, awaitAssertion, ACTION_TIMEOUT, COMMAND_TIMEOUT, VIEWPORT, type StepProof, type Surface } from '../src/browser.ts';
import { showCaption } from '../src/overlay.ts';
import { captureHeightLimit, captureScreenshot } from '../src/screenshot.ts';
import { TERMINAL_WINDOW, expandToSession, shellEnv, terminalPress, terminalRun, terminalWaitForScreen } from '../src/terminal.ts';
import { VERCEL_BYPASS_VAR } from '../src/vercel.ts';
import { launchBrowser, scratchDir, writeFiles, runCli, stepLines, stubFfmpeg, pngSize, pngPixels, rgba, alphaAt, HIGH_DPI_ARGS, REPO } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const SAMPLE = path.join(REPO, 'demos', 'terminal.md');
const SAMPLE_CLI = path.join(REPO, 'examples', 'sample-cli');
const quiet = (): void => {};

/** A terminal assertion, parsed as a terminal script's `_Prove:_` line parses it. */
function parseAssertionFor(code: string): Assertion {
  const a = parseAssertion(code, 'terminal');
  assert.ok(a, `\`${code}\` is not a terminal assertion`);
  return a;
}

/** Bring `md`'s terminal up in a fresh page, hand it to `use`, then end the session and close the page. */
async function withTerminal(md: string, cwd: string, use: (page: Page, demo: Demo, lines: string[]) => Promise<void>): Promise<void> {
  const page = await browser!.newPage({ viewport: VIEWPORT });
  const demo = parseDemoScript(md);
  const lines: string[] = [];
  const surface = await openSurface(page, demo, { cwd, log: (m) => lines.push(m) });
  try {
    await use(page, demo, lines);
  } finally {
    await surface.close();
    await page.close();
  }
}

/** Run every step of `demo` through the step runner, logging into `lines`. */
async function runSteps(page: Page, demo: Demo, lines: string[]): Promise<StepProof[]> {
  const results: StepProof[] = [];
  for (const step of demo.steps) results.push(await runStep(page, '', step, demo.steps.length, false, (m) => lines.push(m)));
  return results;
}

/** One RGB pixel of a PNG, as `#rrggbb`. */
async function pixel(page: Page, png: Buffer, x: number, y: number): Promise<string> {
  const { width, data } = await rgba(page, png);
  const i = (Math.round(y) * width + Math.round(x)) * 4;
  return `#${[data[i], data[i + 1], data[i + 2]].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** The centre of the cell at a 1-based row and column of a cols x rows terminal, in CSS pixels from its window's corner. */
async function cellCentre(page: Page, size: { cols: number; rows: number }, row: number, col: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ size, row, col, win }) => {
      const w = (document.querySelector(win) as HTMLElement).getBoundingClientRect();
      const s = (document.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
      return { x: s.left - w.left + ((col - 0.5) * s.width) / size.cols, y: s.top - w.top + ((row - 0.5) * s.height) / size.rows };
    },
    { size, row, col, win: TERMINAL_WINDOW },
  );
}

/**
 * `node hold.mjs <name> [hup] [screen]`: a program that records its pid in `<name>.pid` and
 * runs until it is killed. With `hup` it handles SIGHUP, records when it arrived in
 * `<name>.hup`, and carries on, and with `screen` it holds the alternate screen.
 */
const HOLD = `import { writeFileSync } from 'node:fs';
const [name, ...flags] = process.argv.slice(2);
if (flags.includes('hup')) process.on('SIGHUP', () => writeFileSync(name + '.hup', String(Date.now())));
writeFileSync(name + '.pid', String(process.pid));
if (flags.includes('screen')) process.stdout.write('\\x1b[?1049h\\x1b[Hheld');
setInterval(() => {}, 1000);
`;

/**
 * Whether a process is still running. A zombie is not: it has exited, and only waits for
 * its parent to collect its status, which for an orphan is init's to do in its own time.
 */
function running(pid: number): boolean {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
}

/** A full-screen program that hides the cursor, paints its screen's corner cells in CORNERS' colours, and holds. */
const PAINT_CORNERS = `const [cols, rows] = [process.stdout.columns, process.stdout.rows];
const cell = (row, col, rgb) => '\\x1b[' + row + ';' + col + 'H\\x1b[48;2;' + rgb + 'm \\x1b[0m';
process.stdout.write('\\x1b[?1049h\\x1b[?25l' + cell(1, 1, '255;0;0') + cell(1, cols, '0;255;0') + cell(rows, 1, '0;0;255') + cell(rows, cols, '255;255;0'));
setInterval(() => {}, 1000);
`;

/** The corner cells PAINT_CORNERS paints, each at a 1-based row and column from the top left, or from the bottom right when negative. */
const CORNERS: { row: number; col: number; colour: string }[] = [
  { row: 1, col: 1, colour: '#ff0000' },
  { row: 1, col: -1, colour: '#00ff00' },
  { row: -1, col: 1, colour: '#0000ff' },
  { row: -1, col: -1, colour: '#ffff00' },
];

/**
 * Where xterm drew the cell whose background is `colour`: its row and column, counted
 * from 1 through the rows and cells xterm drew, and its box in the page. Null when no
 * drawn cell has that background.
 */
async function drawnCell(page: Page, colour: string): Promise<{ row: number; col: number; box: DOMRect } | null> {
  return page.evaluate((hex) => {
    const rgb = `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
    const rows = [...document.querySelectorAll('.xterm-rows > div')];
    for (const [r, line] of rows.entries()) {
      let col = 1;
      for (const node of line.childNodes) {
        if (node instanceof HTMLElement && getComputedStyle(node).backgroundColor === rgb) return { row: r + 1, col, box: node.getBoundingClientRect().toJSON() as DOMRect };
        col += (node.textContent ?? '').length;
      }
    }
    return null;
  }, colour);
}

/**
 * `bash bars.sh <n> <width>`: n lines, each a bar `width` cells wide that begins with its
 * number and whose background colour encodes it: n % 256 red, n / 256 green, blue 200.
 */
const BARS = `for ((n = 1; n <= $1; n++)); do printf '\\033[48;2;%d;%d;200m%-*s\\033[0m\\n' $((n % 256)) $((n / 256)) "$2" "$n"; done
`;

/** The corners of the range of sizes the parser accepts: its most and fewest columns, each with its most and fewest rows. */
const SIZE_LIMITS = [TERMINAL_COLS.max, TERMINAL_COLS.min].flatMap((cols) => [TERMINAL_ROWS.max, TERMINAL_ROWS.min].map((rows) => ({ cols, rows })));

/** A program that prints, in hex, the bytes each key sends, in application cursor-key mode with \`app\`. */
const KEYS = `const app = process.argv[2] === 'app';
process.stdin.setRawMode(true);
process.stdout.write('\\x1b[?1049h\\x1b[H' + (app ? '\\x1b[?1h' : '') + 'ready\\r\\n');
process.stdin.on('data', (b) => {
  if (b.toString() === 'q') {
    process.stdout.write('\\x1b[?1l\\x1b[?1049l');
    process.exit(0);
  }
  process.stdout.write('[' + [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ') + ']\\r\\n');
});
`;

// Each test drives a page, a session or a process of its own, so they run side by side.
describe('the terminal surface', { concurrency: true, skip }, () => {
  test('run waits for each command and logs its exit status, which exit assertions read', async () => {
    const md = `# Demo: Exit status

**Terminal:** 60x12

## Steps

1. **A command that succeeds**
   \`run echo hello\`
   _Prove:_ it printed — \`screen ~ /^hello$/\`
   _Fail if:_ it failed — \`exit > 0\`

2. **A command that fails**
   \`run false\`
   _Prove:_ the shell reports its status — \`exit == 1\`

3. **A status a subshell exits with**
   \`run (exit 3)\`
   _Prove:_ the status is 3 — \`exit == 3\`
`;
    const { dir, cleanup } = scratchDir();
    try {
      await withTerminal(md, dir, async (page, demo, lines) => {
        assert.equal(await checkAssertion(page, parseAssertionFor('exit == 0')), false, 'no status holds before the first command');
        const results = await runSteps(page, demo, lines);
        assert.deepEqual(
          results.map((r) => r.proved),
          [true, true, true],
          lines.join('\n'),
        );
        assert.deepEqual(
          lines.filter((l) => l.startsWith('  · ')),
          ['  · `echo hello` exited 0', '  · `false` exited 1', '  · `(exit 3)` exited 3'],
        );
      });
    } finally {
      cleanup();
    }
  });

  test('no exit assertion holds while a command runs, and one holds once it finishes', async () => {
    const md = `# Demo: Running\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **s**\n   \`run true\`\n`;
    const { dir, cleanup } = scratchDir();
    try {
      await withTerminal(md, dir, async (page) => {
        const exitZero = parseAssertionFor('exit == 0');
        await runAction(page, '', { verb: 'run', target: 'true', raw: 'run true' }, false, quiet);
        assert.equal(await checkAssertion(page, exitZero), true);
        await runAction(page, '', { verb: 'press', target: '"sleep 1" Enter', keys: [{ text: 'sleep 1' }, { key: 'Enter' }], raw: 'press "sleep 1" Enter' }, false, quiet);
        assert.equal(await checkAssertion(page, exitZero), false, 'the sleep is still running');
        assert.equal(await awaitAssertion(page, exitZero, ACTION_TIMEOUT), true, 'the sleep finished with status 0');
      });
    } finally {
      cleanup();
    }
  });

  test('a run whose wait runs out names press and waitForScreen, which drive a program that waits for input on the normal screen', async () => {
    const md = `# Demo: Prompt\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **s**\n   \`run true\`\n`;
    const { dir, cleanup } = scratchDir();
    try {
      await withTerminal(md, dir, async (page) => {
        const read = "read -p 'Name? ' name";
        // Each wait is the engine's own, except the run meant to run out, which gets a second.
        const pace = { typeDelay: 0, promptTimeout: ACTION_TIMEOUT, commandTimeout: COMMAND_TIMEOUT, pause: 0 };
        const press = (spec: string) => terminalPress(page, parseKeys(spec) ?? [], { typeDelay: 0, keyPause: 0, pause: 0 });
        await assert.rejects(terminalRun(page, read, { ...pace, commandTimeout: 1000 }, quiet), {
          message: `\`${read}\` showed no prompt within 1s; for an interactive program on the normal screen, use \`press "${read}" Enter\` and \`waitForScreen\``,
        });
        await press('"Ada" Enter');
        assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), ACTION_TIMEOUT), true, 'the read took its answer and the shell is back');

        // What the error names: press starts the program, and waitForScreen waits for its
        // prompt, whose trailing blank the screen drops.
        await press(`"${read}" Enter`);
        await terminalWaitForScreen(page, parseMatcher('/^Name\\?$/'), ACTION_TIMEOUT);
        await press('"Grace" Enter');
        const lines: string[] = [];
        await terminalRun(page, 'echo "$name"', pace, (m) => lines.push(m));
        assert.deepEqual(lines, ['  · `echo "$name"` exited 0']);
        assert.equal(await checkAssertion(page, parseAssertionFor('screen ~ /^Grace$/')), true);
      });
    } finally {
      cleanup();
    }
  });

  test('the screen joins a row the terminal wrapped; rows and the cursor count from either edge', async () => {
    const md = `# Demo: Wrap

**Terminal:** 20x6

## Steps

1. **A line longer than the terminal is wide**
   \`run echo abcdefghijklmnopqrstuvwxyz\`
   _Prove:_ it reads as one line though it wrapped — \`screen ~ /^abcdefghijklmnopqrstuvwxyz$/\`
`;
    const { dir, cleanup } = scratchDir();
    try {
      await withTerminal(md, dir, async (page, demo, lines) => {
        assert.deepEqual(await runSteps(page, demo, lines), [{ proved: true, manual: false, reason: '' }], lines.join('\n'));
        // `$ echo abc…z` takes rows 1 and 2, its output rows 3 and 4, and the prompt row 5.
        for (const [a, holds] of [
          ['row 3 ~ /^abcdefghijklmnopqrst$/', true],
          ['row 4 ~ /^uvwxyz$/', true],
          ['row 5 ~ /^\\$$/', true],
          ['row -2 ~ /^\\$$/', true],
          ['row -1 ~ /^$/', true],
          ['row 7 ~ /^$/', false],
          ['cursor 5 3', true],
          ['cursor -2 3', true],
          ['cursor 5 2', false],
        ] as const) {
          assert.equal(await checkAssertion(page, parseAssertionFor(a)), holds, a);
        }
      });
    } finally {
      cleanup();
    }
  });

  test("keys reach a program encoded for the terminal's cursor-key mode", async () => {
    const md = `# Demo: Keys\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **s**\n   \`run true\`\n`;
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'keys.mjs': KEYS });
      await withTerminal(md, dir, async (page) => {
        const press = (key: string) => runAction(page, '', { verb: 'press', target: key, keys: [{ key }], raw: `press ${key}` }, false, quiet);
        const run = (command: string) => runAction(page, '', { verb: 'run', target: command, raw: `run ${command}` }, false, quiet);
        await run('node keys.mjs');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "ready"'), ACTION_TIMEOUT), true);
        await press('ArrowUp');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "[1b 5b 41]"'), ACTION_TIMEOUT), true, 'normal mode sends ESC [ A');
        await press('q');
        assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), ACTION_TIMEOUT), true);
        await run('node keys.mjs app');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "ready"'), ACTION_TIMEOUT), true);
        await press('ArrowUp');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "[1b 4f 41]"'), ACTION_TIMEOUT), true, 'application mode sends ESC O A');
        await press('q');
      });
    } finally {
      cleanup();
    }
  });

  test("a full-screen program's alternate screen, cursor and colours are drawn as sent, and quitting restores the shell", async () => {
    const md = `# Demo: Board

**Terminal:** 100x30

## Steps

1. **The board opens**
   \`run node board.mjs\`
   _Prove:_ its frame is along the top — \`row 1 ~ /^┌─ Sprint board ─+┐$/\`

2. **Down one task**
   \`press ArrowDown\`
   _Prove:_ the cursor is in the second checkbox — \`cursor 4 6\`
`;
    await withTerminal(md, SAMPLE_CLI, async (page, demo, lines) => {
      assert.deepEqual(
        (await runSteps(page, demo, lines)).map((r) => r.proved),
        [true, true],
        lines.join('\n'),
      );
      assert.ok(lines.includes('  · `node board.mjs` took over the screen'), 'run settles once the board holds the alternate screen');
      assert.equal(await checkAssertion(page, parseAssertionFor('row -1 ~ /1 of 3 done$/')), true, 'the status bar is on the bottom row');

      // The board paints the selected row in 24-bit colour, the status bar in colour 24 of
      // the 256, and leaves the rest on the terminal's background.
      const png = await page.locator(TERMINAL_WINDOW).screenshot();
      const at = async (row: number, col: number): Promise<string> => {
        const c = await cellCentre(page, { cols: 100, rows: 30 }, row, col);
        return pixel(page, png, c.x, c.y);
      };
      assert.equal(await at(4, 40), '#263854', 'the selected row');
      assert.equal(await at(30, 60), '#005f87', 'the status bar');
      assert.equal(await at(3, 40), '#0f1115', 'an unlit row');

      await runAction(page, '', { verb: 'press', target: 'q', keys: [{ key: 'q' }], raw: 'press q' }, false, quiet);
      assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), ACTION_TIMEOUT), true);
      assert.equal(await checkAssertion(page, parseAssertionFor('screen ~ "Sprint board"')), false, 'the alternate screen is gone');
      assert.equal(await checkAssertion(page, parseAssertionFor('screen ~ /^\\$ node board\\.mjs$/')), true, 'the shell screen is back');
      assert.equal(await checkAssertion(page, parseAssertionFor('screen ~ /^1 of 3 done$/')), true);
    });
  });

  test('--full-page holds the whole session in the window; the default holds the screen', async () => {
    const md = `# Demo: Long\n\n**Terminal:** 40x10\n\n## Steps\n\n1. **Fifty lines**\n   \`run seq 1 50\`\n   _Prove:_ the last is on screen — \`screen ~ /^50$/\`\n`;
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      const shot = async (fullPage: boolean): Promise<{ rows: number; first: string | null; height: number }> => {
        const out = path.join(dir, fullPage ? 'full.png' : 'screen.png');
        await captureScreenshot({ page, demo: md, cwd: dir, outputPath: out, fullPage, log: quiet });
        const { rows, first } = await page.evaluate(() => {
          const t = (window as unknown as { __ss_term: { cursor(): { rows: number }; row(n: number): string | null } }).__ss_term;
          return { rows: t.cursor().rows, first: t.row(1) };
        });
        return { rows, first, height: pngSize(out).height };
      };
      const screen = await shot(false);
      const full = await shot(true);
      assert.equal(screen.rows, 10);
      // `$ seq 1 50`, the fifty lines, and the prompt after them.
      assert.equal(full.rows, 52);
      assert.equal(full.first, '$ seq 1 50');
      assert.ok(full.height > screen.height * 4, `${full.height} is not the whole session against ${screen.height}`);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('--full-page starts the window at the first line of the session when the shell cleared the screen below its scrollback', async () => {
    // The printf homes the cursor and erases the screen but keeps the scrollback, as
    // `tput clear` does, so the cursor is not on the bottom row when the window grows.
    const md = `# Demo: Cleared\n\n**Terminal:** 40x10\n\n## Steps\n\n1. **Lines, then a cleared screen**\n   \`run seq 1 30\`\n   \`run printf '\\033[H\\033[2J'\`\n   _Prove:_ the prompt is back on the top row — \`row 1 ~ /^\\$$/\`\n`;
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      const res = await captureScreenshot({ page, demo: md, cwd: dir, outputPath: path.join(dir, 'cleared.png'), fullPage: true, log: quiet });
      assert.equal(res.failures, 0);
      const { drawn, slider } = await page.evaluate(() => ({
        drawn: [...document.querySelectorAll('.xterm-rows > div')].map((row) => (row.textContent ?? '').trimEnd()),
        slider: getComputedStyle(document.querySelector('.xterm .scrollbar.vertical .slider') as Element).backgroundColor,
      }));
      // `$ seq 1 30` and the lines the clear left in the scrollback, then the prompt it moved to the top.
      assert.deepEqual(drawn, ['$ seq 1 30', ...Array.from({ length: 22 }, (_, i) => String(i + 1)), '$']);
      assert.equal(slider, 'rgba(0, 0, 0, 0)', 'the scrollbar xterm shows once the window scrolls draws nothing');
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('a window grown to the session holds its last lines when the session is more than the window may hold, and none when not one line fits', async () => {
    const md = `# Demo: Long\n\n**Terminal:** 40x10\n\n## Steps\n\n1. **Fifty lines**\n   \`run seq 1 50\`\n`;
    const { dir, cleanup } = scratchDir();
    try {
      await withTerminal(md, dir, async (page, demo, lines) => {
        await runSteps(page, demo, lines);
        const { frame, row } = await page.evaluate((win) => {
          const w = (document.querySelector(win) as HTMLElement).getBoundingClientRect();
          const s = (document.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
          return { frame: w.height - s.height, row: s.height / 10 };
        }, TERMINAL_WINDOW);
        const drawn = (): Promise<string[]> => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')].map((r) => (r.textContent ?? '').trimEnd()));
        // Room for twenty and a half rows, where the session is `$ seq 1 50`, the fifty lines, and the prompt.
        assert.deepEqual(await expandToSession(page, frame + 20.5 * row), { rows: 20, lines: 52 });
        const last20 = [...Array.from({ length: 19 }, (_, i) => String(32 + i)), '$'];
        assert.deepEqual(await drawn(), last20);
        // Room for half a row: the window is left as it is.
        assert.deepEqual(await expandToSession(page, frame + 0.5 * row), { rows: 0, lines: 52 });
        assert.deepEqual(await drawn(), last20);
      });
    } finally {
      cleanup();
    }
  });

  test('a full-page still of a page whose terminal window is gone fails with the screenshot error, counting the steps whose proof failed', async () => {
    const md = `# Demo: Gone\n\n**Terminal:** 40x10\n\n## Steps\n\n1. **A command that fails**\n   \`run false\`\n   _Fail if:_ it failed — \`exit > 0\`\n`;
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      // The terminal is written into this page's document, whose realm keeps this lookup, so the capture finds no window.
      await page.evaluate((win) => {
        const find = Document.prototype.querySelector;
        Document.prototype.querySelector = function (this: Document, sel: string) {
          return sel === win ? null : find.call(this, sel);
        } as typeof find;
      }, TERMINAL_WINDOW);
      const png = path.join(dir, 'gone.png');
      await assert.rejects(captureScreenshot({ page, demo: md, cwd: dir, outputPath: png, fullPage: true, log: quiet }), {
        message: 'screenshot: could not measure the terminal window (1 step(s) failed their proof): this page has no terminal window',
      });
      assert.equal(existsSync(png), false);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('--full-page refuses a still at a scale where one capture cannot hold a line of the session, and saves nothing', async () => {
    const scale = 100;
    const md = `# Demo: Short\n\n**Terminal:** 20x5\n\n## Steps\n\n1. **One line**\n   \`run echo hi\`\n`;
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage({ deviceScaleFactor: scale });
    try {
      const png = path.join(dir, 'x.png');
      await assert.rejects(captureScreenshot({ page, demo: md, cwd: dir, outputPath: png, fullPage: true, log: quiet }), {
        message: new RegExp(`^screenshot: could not capture the terminal session: scale ${scale} is too large for one capture of a window \\d+ CSS pixels wide$`),
      });
      assert.equal(existsSync(png), false);
      // One capture would hold some rows of pixels, just not a whole line of the window.
      const width = await page.evaluate((win) => (document.querySelector(win) as HTMLElement).getBoundingClientRect().width, TERMINAL_WINDOW);
      assert.ok(captureHeightLimit(width, scale) >= 1);
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('the shell, and every program it still runs, end before the capture returns, even one that handles SIGHUP', async () => {
    const md = `# Demo: Hold

**Terminal:** 40x10

## Steps

1. **A background job that handles SIGHUP**
   \`run echo $$ > shell.pid\`
   \`run node hold.mjs job hup & until [ -s job.pid ]; do sleep 0.1; done\`

2. **A full-screen program that handles SIGHUP**
   \`run node hold.mjs tui hup screen\`
   _Prove:_ it holds the screen — \`screen ~ "held"\`
`;
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    const names = ['shell', 'job', 'tui'];
    const pidOf = (name: string): number => Number(existsSync(path.join(dir, `${name}.pid`)) ? readFileSync(path.join(dir, `${name}.pid`), 'utf8') : 0);
    try {
      writeFiles(dir, { 'hold.mjs': HOLD });
      const res = await captureScreenshot({ page, demo: md, cwd: dir, outputPath: path.join(dir, 'held.png'), log: quiet });
      assert.equal(res.failures, 0);
      for (const name of names) {
        const pid = pidOf(name);
        assert.ok(pid > 1, `${name}.pid holds a pid`);
        assert.equal(running(pid), false, `the ${name} (pid ${pid}) outlived the capture`);
      }
    } finally {
      // Nothing the capture left running outlives the test.
      for (const pid of names.map(pidOf)) if (pid > 1 && running(pid)) process.kill(pid, 'SIGKILL');
      await page.close();
      cleanup();
    }
  });

  test('a slow listing of the session delays its end and never cuts it short', { skip: process.platform === 'linux' && 'Linux lists the session from /proc, with no ps' }, async () => {
    const { dir, cleanup } = scratchDir();
    const pidOf = (name: string): number => Number(existsSync(path.join(dir, `${name}.pid`)) ? readFileSync(path.join(dir, `${name}.pid`), 'utf8') : 0);
    try {
      writeFiles(dir, {
        'hold.mjs': HOLD,
        // A ps as slow as a busy host's, which notes that it ran.
        'bin/ps': `#!/bin/sh\necho "$@" >> '${path.join(dir, 'ps.calls')}'\nsleep 4\nexec /bin/ps "$@"\n`,
        'demo.md': `# Demo: Slow listing\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **A job that handles SIGHUP**\n   \`run node hold.mjs job hup & until [ -s job.pid ]; do sleep 0.1; done\`\n`,
      });
      chmodSync(path.join(dir, 'bin', 'ps'), 0o755);
      const env = { ...process.env, PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}` };
      const res = await runCli(['screenshot', path.join(dir, 'demo.md'), '--cwd', dir, '-o', path.join(dir, 'shot.png')], { cwd: dir, env });
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      assert.ok(existsSync(path.join(dir, 'ps.calls')), 'the engine listed the session with the slow ps');
      assert.equal(running(pidOf('job')), false, `the job outlived the capture\n${res.stdout}`);
      assert.doesNotMatch(res.stdout, /terminal: could not list the shell's jobs/);
    } finally {
      const pid = pidOf('job');
      if (pid > 1 && running(pid)) process.kill(pid, 'SIGKILL');
      cleanup();
    }
  });

  for (const size of SIZE_LIMITS) {
    test(`a ${size.cols}x${size.rows} terminal is drawn whole in a video frame, its corner cells clear of the caption bar`, async () => {
      const md = `# Demo: Corners\n\n**Terminal:** ${size.cols}x${size.rows}\n\n## Steps\n\n1. **s**\n   \`run node corners.mjs\`\n`;
      const { dir, cleanup } = scratchDir();
      writeFiles(dir, { 'corners.mjs': PAINT_CORNERS });
      // A video frame: the window on the backdrop, at the drivers' viewport, under the step's caption.
      const page = await browser!.newPage({ viewport: VIEWPORT });
      let surface: Surface | null = null;
      try {
        surface = await openSurface(page, parseDemoScript(md), { cwd: dir, backdrop: true, log: quiet });
        await runAction(page, '', { verb: 'run', target: 'node corners.mjs', raw: 'run node corners.mjs' }, false, quiet);
        await surface.settle();
        await showCaption(page, 1, 1, 's', false);
        const png = await page.screenshot();
        const box = (selector: string) => page.locator(selector).evaluate((el) => el.getBoundingClientRect().toJSON() as DOMRect);
        const [win, screen, caption] = await Promise.all([box(TERMINAL_WINDOW), box('.xterm-screen'), box('#__ss_caption__')]);
        const where = `window ${JSON.stringify(win)}, screen ${JSON.stringify(screen)}`;
        assert.ok(win.left >= 0 && win.top >= 0 && win.right <= VIEWPORT.width, `the window is inside the frame: ${where}`);
        assert.ok(win.bottom <= caption.top, `the window clears the caption bar at ${caption.top}: ${where}`);
        assert.ok(screen.left >= win.left && screen.right <= win.right && screen.top >= win.top && screen.bottom <= win.bottom, `the window holds the whole screen: ${where}`);
        for (const { row, col, colour } of CORNERS) {
          const corner = { row: row > 0 ? row : size.rows + row + 1, col: col > 0 ? col : size.cols + col + 1 };
          const cell = await drawnCell(page, colour);
          assert.ok(cell, `no cell is drawn in ${colour}`);
          assert.deepEqual({ row: cell.row, col: cell.col }, corner, `the ${colour} cell is drawn at its corner`);
          const [x, y] = [cell.box.left + cell.box.width / 2, cell.box.top + cell.box.height / 2];
          assert.ok(x >= screen.left && x < screen.right && y >= screen.top && y < screen.bottom, `the cell at row ${corner.row}, column ${corner.col} is inside the screen: (${x}, ${y}), ${where}`);
          assert.equal(await pixel(page, png, x, y), colour, `the frame shows the cell at row ${corner.row}, column ${corner.col} at (${Math.round(x)}, ${Math.round(y)})`);
        }
      } finally {
        await surface?.close();
        await page.close();
        cleanup();
      }
    });
  }

  test('a terminal that cannot fit its page at any font size is refused before its shell starts', async () => {
    const size = `${TERMINAL_COLS.max}x${TERMINAL_ROWS.max}`;
    const md = `# Demo: Too big\n\n**Terminal:** ${size}\n\n## Steps\n\n1. **s**\n   \`run true\`\n`;
    const page = await browser!.newPage({ viewport: { width: 200, height: 150 } });
    const lines: string[] = [];
    try {
      // A surface that opens anyway is closed, so its shell does not outlive the test.
      const opened = openSurface(page, parseDemoScript(md), { log: (m) => lines.push(m) }).then((surface) => surface.close());
      await assert.rejects(opened, new RegExp(`terminal: a ${size} terminal does not fit a 200x150 page even at 1 px`));
      assert.deepEqual(lines, [], 'no shell was started');
    } finally {
      await page.close();
    }
  });

  test('sprintshow screenshot saves the sample terminal window at --scale 2 with transparent corners, and exits 0', async () => {
    const { dir, cleanup } = scratchDir();
    const page = await browser!.newPage();
    try {
      const one = path.join(dir, 'one.png');
      const two = path.join(dir, 'two.png');
      const full = path.join(dir, 'full.png');
      const [a, b, c] = await Promise.all([
        runCli(['screenshot', SAMPLE, '--cwd', SAMPLE_CLI, '-o', one]),
        runCli(['screenshot', SAMPLE, '--cwd', SAMPLE_CLI, '--scale', '2', '-o', two]),
        runCli(['screenshot', SAMPLE, '--cwd', SAMPLE_CLI, '--full-page', '-o', full]),
      ]);
      for (const res of [a, b, c]) {
        assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
        assert.deepEqual(
          stepLines(res.stdout).filter((l) => l.startsWith('  ')),
          Array(6).fill('  ✓ proof held'),
        );
      }
      assert.match(a.stdout, /screenshot: capturing the terminal window → one\.png/);
      assert.match(c.stdout, /screenshot: capturing the whole terminal session → full\.png/);
      const [s1, s2, sf] = [pngSize(one), pngSize(two), pngSize(full)];
      assert.equal(s2.width, s1.width * 2);
      assert.ok(Math.abs(s2.height - s1.height * 2) <= 2, `height ${s2.height} is not twice ${s1.height}`);
      assert.equal(sf.width, s1.width);
      assert.ok(sf.height < s1.height, 'the sample session is shorter than its screen, and the whole session is drawn tight');
      assert.equal(await alphaAt(page, one, 0, 0), 0, 'the corner is transparent');
      assert.equal(await alphaAt(page, one, Math.floor(s1.width / 2), Math.floor(s1.height / 2)), 255, 'the window is opaque');
      assert.equal(readFileSync(path.join(SAMPLE_CLI, 'tasks.md'), 'utf8').split('\n')[1], '- [ ] Write the README', 'the board saved nothing');
    } finally {
      await page.close();
      cleanup();
    }
  });

  test('proof mode and the walkthrough film a terminal script through the runner, as the screenshot reports it', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, {
        'demo.md': `# Demo: Two commands\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **One**\n   \`run echo one\`\n   _Prove:_ it printed — \`screen ~ /^one$/\`\n\n2. **Two fails**\n   \`run false\`\n   _Fail if:_ it failed — \`exit > 0\`\n`,
      });
      const env = { ...process.env, FFMPEG_BIN: stubFfmpeg(dir), OPENAI_API_KEY: '' };
      const common = [path.join(dir, 'demo.md'), '--cwd', dir];
      const [proof, walk, shot] = await Promise.all([
        runCli(['run', ...common, '--mode', 'proof', '--no-narrate', '-o', path.join(dir, 'proof.mp4')], { cwd: dir, env }),
        runCli(['run', ...common, '--no-narrate', '-o', path.join(dir, 'walk.mp4')], { cwd: dir, env }),
        runCli(['screenshot', ...common, '-o', path.join(dir, 'shot.png')], { cwd: dir, env }),
      ]);
      const expected = ['step 1/2: One', '  ✓ proof held', 'step 2/2: Two fails', '  ✗ _Fail if:_ condition matched: `exit > 0`'];
      for (const res of [proof, walk, shot]) {
        assert.equal(res.code, 3, `a failed proof still saves the output\n${res.stdout}${res.stderr}`);
        assert.deepEqual(stepLines(res.stdout), expected);
      }
      for (const out of ['proof.mp4', 'walk.mp4', 'shot.png']) assert.ok(existsSync(path.join(dir, out)), out);
    } finally {
      cleanup();
    }
  });

  test('the walkthrough ends the session once its recording is flushed, so a program slow to end is not filmed', async () => {
    const { dir, cleanup } = scratchDir();
    const pidOf = (name: string): number => Number(existsSync(path.join(dir, `${name}.pid`)) ? readFileSync(path.join(dir, `${name}.pid`), 'utf8') : 0);
    try {
      writeFiles(dir, {
        'hold.mjs': HOLD,
        'demo.md': `# Demo: Slow to end\n\n**Terminal:** 60x12\n\n## Steps\n\n1. **A job that handles SIGHUP**\n   \`run node hold.mjs job hup & until [ -s job.pid ]; do sleep 0.1; done\`\n`,
      });
      const env = { ...process.env, FFMPEG_BIN: stubFfmpeg(dir), OPENAI_API_KEY: '' };
      const res = await runCli(['run', path.join(dir, 'demo.md'), '--cwd', dir, '--no-narrate', '--keep', '-o', path.join(dir, 'walk.mp4')], { cwd: dir, env });
      assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
      const kept = path.join(dir, '.captures', readdirSync(path.join(dir, '.captures'))[0]);
      const webm = readdirSync(kept).find((f) => f.endsWith('.webm'));
      assert.ok(webm, `the kept run holds the recording: ${readdirSync(kept).join(', ')}`);
      // The job handles SIGHUP, so ending it takes SIGKILL's grace. Ended before the flush,
      // that grace would be filmed, and the recording would end seconds after the SIGHUP.
      const flushed = statSync(path.join(kept, webm)).mtimeMs;
      const hup = Number(readFileSync(path.join(dir, 'job.hup'), 'utf8'));
      assert.ok(flushed < hup + 1000, `the recording was flushed ${Math.round(flushed - hup)} ms after the job's SIGHUP`);
      assert.equal(running(pidOf('job')), false, 'the job outlived the capture');
    } finally {
      const pid = pidOf('job');
      if (pid > 1 && running(pid)) process.kill(pid, 'SIGKILL');
      cleanup();
    }
  });
});

// On a busy host a capture near the most Chromium draws in one takes tens of seconds, and
// the tests running beside it time out, so these run once they are done, one at a time.
// The shared browser draws in 256-pixel tiles, and the other in 512-pixel tiles, as a
// browser started on a high-DPI screen on macOS does.
for (const tiles of [256, 512]) {
  test(`--full-page keeps the session's last lines when the whole session is more than Chromium draws in one capture, in a browser that draws in ${tiles}-pixel tiles`, { skip }, async () => {
    // At scale 3, a thousand lines of an 80-column terminal are more than Chromium draws in
    // one capture, whatever the height the font gives a row.
    const scale = 3;
    const md = `# Demo: Bars\n\n**Terminal:** 80x24\n\n## Steps\n\n1. **A thousand numbered bars**\n   \`run bash bars.sh 1000 79\`\n   _Prove:_ the last bar is on screen — \`screen ~ /^1000$/\`\n`;
    const { dir, cleanup } = scratchDir();
    writeFiles(dir, { 'bars.sh': BARS });
    const own = tiles === 512 ? (await launchBrowser(HIGH_DPI_ARGS)).browser : null;
    try {
      const page = await (own ?? browser!).newPage({ deviceScaleFactor: scale });
      try {
        const out = path.join(dir, 'bars.png');
        const lines: string[] = [];
        const res = await captureScreenshot({ page, demo: md, cwd: dir, outputPath: out, fullPage: true, log: (m) => lines.push(m) });
        assert.equal(res.failures, 0, lines.join('\n'));
        const held = await page.evaluate((win) => {
          const w = (document.querySelector(win) as HTMLElement).getBoundingClientRect();
          const s = (document.querySelector('.xterm-screen') as HTMLElement).getBoundingClientRect();
          const t = (window as unknown as { __ss_term: { cursor(): { rows: number }; row(n: number): string | null } }).__ss_term;
          const rows = t.cursor().rows;
          return { width: w.width, height: w.height, top: s.top - w.top, left: s.left - w.left, cell: { width: s.width / 80, height: s.height / rows }, rows, last: t.row(-1) };
        }, TERMINAL_WINDOW);
        // The session is `$ bash bars.sh 1000 79`, the bars, and the prompt after them.
        assert.equal(lines.at(-1), `screenshot: capturing the session's last ${held.rows} of its 1002 lines, the most one capture holds at scale ${scale} → bars.png`);
        // The window holds as many rows as fit the limit, and one more would pass it.
        const limit = captureHeightLimit(held.width, scale);
        assert.ok(held.height <= limit && held.height + held.cell.height > limit, `a ${held.height} px window is not the most rows a ${limit} px capture holds`);
        assert.deepEqual(pngSize(out), { width: Math.ceil(held.width) * scale, height: Math.ceil(held.height) * scale });
        // Chromium drew every row, the bottom ones too, and they are the session's last
        // lines: the bars from the one its first row shows, then the prompt.
        const bars = Array.from({ length: held.rows - 1 }, (_, r) => 1002 - held.rows + r);
        const x = Math.round((held.left + 76.5 * held.cell.width) * scale);
        const drawn = await pngPixels(out, bars.map((_, r) => ({ x, y: Math.round((held.top + (r + 0.5) * held.cell.height) * scale) })));
        const near = (got: number, want: number): boolean => Math.abs(got - want) <= 2;
        const wrong = bars.flatMap((n, r) => {
          const [red, green, blue, alpha] = drawn[r];
          return near(red, n % 256) && near(green, Math.floor(n / 256)) && near(blue, 200) && alpha === 255 ? [] : [`row ${r + 1}, bar ${n}: rgba(${drawn[r].join(', ')})`];
        });
        assert.deepEqual(wrong, []);
        assert.equal(held.last, '$');
      } finally {
        await page.close();
      }
    } finally {
      await own?.close();
      cleanup();
    }
  });
}

test('a terminal script refuses a server, a selector, or a missing directory before anything starts', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const png = path.join(dir, 'x.png');
    const cases: [string[], RegExp][] = [
      [['--serve-dir', dir], /terminal: a terminal script runs in the engine's own terminal and takes no server/],
      [['--base-url', 'http://localhost:1'], /takes no server/],
      [['--port', '4000'], /takes no server/],
      [['--selector', '#board'], /screenshot: a terminal script captures its terminal window; --selector picks an element of a page script/],
      [['--cwd', path.join(dir, 'missing')], /terminal: the shell cannot start in .*missing, which is not a directory/],
    ];
    const results = await Promise.all(cases.map(([flags]) => runCli(['screenshot', SAMPLE, ...flags, '-o', png])));
    results.forEach((res, i) => {
      assert.equal(res.code, 1, `${cases[i][0].join(' ')}\n${res.stdout}${res.stderr}`);
      assert.match(res.stderr, cases[i][1]);
      assert.doesNotMatch(res.stdout, /terminal: bash in/, 'no shell was started');
    });
    const run = await runCli(['run', SAMPLE, '--serve-dir', dir, '-o', path.join(dir, 'x.mp4')]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /takes no server/);
    assert.equal(existsSync(png), false);
  } finally {
    cleanup();
  }
});

test('a capture whose shell cannot start fails with a reason and saves nothing', { skip }, async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const png = path.join(dir, 'x.png');
    const res = await runCli(['screenshot', SAMPLE, '--cwd', SAMPLE_CLI, '-o', png], { env: { ...process.env, PATH: path.join(dir, 'empty') } });
    assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /terminal: bash exited with status \d+ before its first prompt; a terminal script needs bash on PATH/);
    assert.equal(existsSync(png), false);
  } finally {
    cleanup();
  }
});

test("the shell inherits the engine's environment less the Vercel bypass key and what describes another terminal, and keeps OPENAI_API_KEY", () => {
  const env = shellEnv({ PATH: '/usr/bin:/bin', HOME: '/home/demo', OPENAI_API_KEY: 'openai-key', [VERCEL_BYPASS_VAR]: 'bypass-key', TMUX: '/tmp/tmux-1/default,1,0', COLUMNS: '200' });
  assert.equal(VERCEL_BYPASS_VAR in env, false);
  assert.equal(Object.values(env).includes('bypass-key'), false, 'no variable carries the bypass key');
  assert.equal(env.OPENAI_API_KEY, 'openai-key');
  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/demo');
  assert.equal('TMUX' in env, false);
  assert.equal('COLUMNS' in env, false);
  assert.equal(env.TERM, 'xterm-256color');
});
