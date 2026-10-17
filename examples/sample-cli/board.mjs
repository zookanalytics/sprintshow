#!/usr/bin/env node
// The sample's sprint board, in a terminal. demos/terminal.md drives it.
//
//   node board.mjs [file]            the full-screen board (default file: tasks.md)
//   node board.mjs --summary [file]  each task and a count, in colour
//
// The board is a small curses-style program. It switches to the alternate screen and to
// application cursor-key mode, draws a box and a status bar by cursor addressing in 256
// and 24-bit colour, and parks the cursor in the selected task's checkbox. Up and down
// (or k and j) move the selection, space toggles the task, and q quits, which restores
// the shell's screen and prints the count. Nothing is written back to the file.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const summary = args.includes('--summary');
const file = args.find((a) => !a.startsWith('--')) ?? 'tasks.md';

let source;
try {
  source = readFileSync(file, 'utf8');
} catch (e) {
  console.error(`board: cannot read ${file}: ${e.message}`);
  process.exit(1);
}
const tasks = source
  .split('\n')
  .map((line) => line.match(/^- \[( |x)\] (.+)$/))
  .filter(Boolean)
  .map((m) => ({ done: m[1] === 'x', title: m[2] }));

const CSI = '\x1b[';
const RESET = `${CSI}0m`;
const done = () => tasks.filter((t) => t.done).length;

if (summary) {
  for (const t of tasks) console.log(`${t.done ? `${CSI}32m[x]` : `${CSI}33m[ ]`}${RESET} ${t.title}`);
  console.log(`${CSI}1m${tasks.length} tasks · ${done()} done${RESET}`);
  process.exit(0);
}

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('board: the board needs a terminal; pass --summary for a count');
  process.exit(2);
}

let selected = 0;

/** Draw the whole board in one write: the box, the tasks, the status bar, then the cursor. */
function draw() {
  const { columns, rows } = process.stdout;
  const width = Math.min(columns, 64);
  const at = (row, col) => `${CSI}${row};${col}H`;
  let out = `${CSI}H${CSI}2J`;
  out += `${at(1, 1)}${CSI}36m┌─ ${CSI}1;97mSprint board${CSI}22;36m ${'─'.repeat(width - 17)}┐`;
  for (let row = 2; row <= tasks.length + 3; row++) out += `${at(row, 1)}│${at(row, width)}│`;
  out += `${at(tasks.length + 4, 1)}└${'─'.repeat(width - 2)}┘${RESET}`;
  tasks.forEach((t, i) => {
    const mark = t.done ? `${CSI}32m[x]${RESET}` : '[ ]';
    const title = t.done ? `${CSI}2;9m${t.title}${RESET}` : t.title;
    const pad = ' '.repeat(Math.max(0, width - 9 - t.title.length));
    const line = `${i === selected ? '▶' : ' '} ${mark} ${title}${pad}`;
    // The selected row is lit with a 24-bit background, re-applied after each reset.
    const lit = i === selected ? `${CSI}48;2;38;56;84m${line.replaceAll(RESET, `${RESET}${CSI}48;2;38;56;84m`)}${RESET}` : line;
    out += `${at(i + 3, 3)}${lit}`;
  });
  const left = ' ↑/↓ move · space toggle · q quit';
  const right = `${done()} of ${tasks.length} done `;
  out += `${at(rows, 1)}${CSI}48;5;24;38;5;231m${left}${' '.repeat(Math.max(1, columns - left.length - right.length))}${right}${RESET}`;
  out += at(selected + 3, 6);
  process.stdout.write(out);
}

function quit() {
  process.stdout.write(`${CSI}?1l${CSI}?1049l`);
  console.log(`${done()} of ${tasks.length} done`);
  process.exit(0);
}

/** Split what one read delivered into keys: an arrow's escape sequence in either cursor-key mode, or one character. */
function keys(data) {
  const out = [];
  let s = data;
  while (s) {
    const arrow = s.match(/^\x1b[[O]([AB])/);
    if (arrow) {
      out.push(arrow[1] === 'A' ? 'up' : 'down');
      s = s.slice(arrow[0].length);
    } else {
      out.push(s[0]);
      s = s.slice(1);
    }
  }
  return out;
}

process.stdout.write(`${CSI}?1049h${CSI}?1h`);
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (data) => {
  for (const key of keys(data)) {
    if (key === 'q' || key === '\x03') return quit();
    if (key === 'up' || key === 'k') selected = Math.max(0, selected - 1);
    if (key === 'down' || key === 'j') selected = Math.min(tasks.length - 1, selected + 1);
    if (key === ' ') tasks[selected].done = !tasks[selected].done;
  }
  draw();
});
process.stdout.on('resize', draw);
draw();
