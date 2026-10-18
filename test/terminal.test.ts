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
// terminal window with transparent corners, `--full-page` holds the whole session, and a
// terminal script refuses a server, a selector, or a directory that does not exist before
// a browser is spent. A video frame shows every cell of a terminal at each limit of the
// sizes the parser accepts, clear of the caption bar. The shell and every program it
// still runs end before the capture returns, even a program that handles SIGHUP.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

import { parseDemoScript, parseAssertion, parseKeys, parseMatcher, TERMINAL_COLS, TERMINAL_ROWS, type Assertion, type Demo } from '../src/demo-script.ts';
import { openSurface, runStep, runAction, checkAssertion, awaitAssertion, VIEWPORT, type StepProof, type Surface } from '../src/browser.ts';
import { showCaption } from '../src/overlay.ts';
import { captureScreenshot } from '../src/screenshot.ts';
import { TERMINAL_WINDOW, terminalPress, terminalRun, terminalWaitForScreen } from '../src/terminal.ts';
import { launchBrowser, scratchDir, writeFiles, runCli, stepLines, stubFfmpeg, pngSize, rgba, alphaAt, REPO } from './browser-fixture.ts';

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
 * runs until it is killed. With `hup` it handles SIGHUP and carries on, and with `screen`
 * it holds the alternate screen.
 */
const HOLD = `import { writeFileSync } from 'node:fs';
const [name, ...flags] = process.argv.slice(2);
if (flags.includes('hup')) process.on('SIGHUP', () => {});
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
        assert.equal(await awaitAssertion(page, exitZero, 5000), true, 'the sleep finished with status 0');
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
        const pace = { typeDelay: 0, promptTimeout: 5000, commandTimeout: 1000, pause: 0 };
        const press = (spec: string) => terminalPress(page, parseKeys(spec) ?? [], { typeDelay: 0, keyPause: 0, pause: 0 });
        await assert.rejects(terminalRun(page, read, pace, quiet), {
          message: `\`${read}\` showed no prompt within 1s; for an interactive program on the normal screen, use \`press "${read}" Enter\` and \`waitForScreen\``,
        });
        await press('"Ada" Enter');
        assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), 5000), true, 'the read took its answer and the shell is back');

        // What the error names: press starts the program, and waitForScreen waits for its
        // prompt, whose trailing blank the screen drops.
        await press(`"${read}" Enter`);
        await terminalWaitForScreen(page, parseMatcher('/^Name\\?$/'), 5000);
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
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "ready"'), 5000), true);
        await press('ArrowUp');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "[1b 5b 41]"'), 5000), true, 'normal mode sends ESC [ A');
        await press('q');
        assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), 5000), true);
        await run('node keys.mjs app');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "ready"'), 5000), true);
        await press('ArrowUp');
        assert.equal(await awaitAssertion(page, parseAssertionFor('screen ~ "[1b 4f 41]"'), 5000), true, 'application mode sends ESC O A');
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
      assert.equal(await awaitAssertion(page, parseAssertionFor('exit == 0'), 5000), true);
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
});

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
