// Tests for the pure demo-script parser (src/demo-script.ts).
//
//   node --test "test/**/*.test.ts"
//
// The parser is the contract between a human-legible walkthrough and the deterministic
// driver, so the grammar (actions, `_Prove:_`/`_Fail if:_` assertions, matchers) is
// pinned here rather than discovered at capture time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDemoScript, parseAction, parseAssertion, parseMatcher, parseKeys, parseTerminalSpec, parseDeviceSpec, parseViewportSize, deviceName, unknownDevice, surfaceOf, slugify, outputSlug, DEFAULT_TERMINAL } from '../src/demo-script.ts';

const SCRIPT = `# Demo: Task Board

**Start:** \`/?seed=board&anim=off\`

Prove the board adds and completes tasks.
Second line of subtitle.

## Steps

1. **The board boots empty**
   \`waitFor #board\`
   The page loads straight into the board.
   _Prove:_ the empty-state hint shows — \`visible #empty-hint\`
   _Fail if:_ a task already exists — \`visible .task\`

2. **A task is added and rendered**
   \`type #new-task ~ Ship the demo\`
   \`click #add\`
   \`wait 300\`
   _Prove:_ one task renders — \`count .task >= 1\`
`;

test('parses title, start (backticks stripped), and multi-line description', () => {
  const d = parseDemoScript(SCRIPT);
  assert.equal(d.title, 'Task Board');
  assert.equal(d.start, '/?seed=board&anim=off');
  assert.equal(d.description, 'Prove the board adds and completes tasks. Second line of subtitle.');
  assert.equal(d.steps.length, 2);
});

test('step 1: narration, action, description, prove + failIf assertions', () => {
  const s = parseDemoScript(SCRIPT).steps[0];
  assert.equal(s.index, 1);
  assert.equal(s.narration, 'The board boots empty');
  assert.deepEqual(s.actions, [{ verb: 'waitFor', target: '#board', raw: 'waitFor #board' }]);
  assert.equal(s.description, 'The page loads straight into the board.');
  assert.equal(s.prove?.assertion?.kind, 'visible');
  assert.equal(s.prove?.assertion?.selector, '#empty-hint');
  assert.match(s.prove?.prose ?? '', /empty-state hint shows/);
  assert.equal(s.failIf?.assertion?.kind, 'visible');
  assert.equal(s.failIf?.assertion?.selector, '.task');
});

test('step 2: multiple actions accumulate in order, including type', () => {
  const s = parseDemoScript(SCRIPT).steps[1];
  assert.deepEqual(
    s.actions.map((a) => a.verb),
    ['type', 'click', 'wait'],
  );
  assert.equal(s.actions[0].target, '#new-task');
  assert.equal(s.actions[0].text, 'Ship the demo');
  assert.equal(s.actions[2].ms, 300);
  assert.equal(s.prove?.assertion?.kind, 'count');
  assert.equal(s.prove?.assertion?.selector, '.task');
  assert.equal(s.prove?.assertion?.op, '>=');
  assert.equal(s.prove?.assertion?.n, 1);
});

test('parseAction: each verb, and a non-verb rejected', () => {
  assert.deepEqual(parseAction('goto /?seed=x'), { verb: 'goto', target: '/?seed=x', raw: 'goto /?seed=x' });
  assert.deepEqual(parseAction('click #add'), { verb: 'click', target: '#add', raw: 'click #add' });
  assert.equal(parseAction('wait 1200')?.ms, 1200);
  assert.equal(parseAction('waitForText #a .b ~ hi there')?.text, 'hi there');
  assert.deepEqual(parseAction('type #new-task ~ hello world'), { verb: 'type', target: '#new-task', text: 'hello world', raw: 'type #new-task ~ hello world' });
  assert.deepEqual(parseAction('scroll #panel'), { verb: 'scroll', target: '#panel', raw: 'scroll #panel' });
  assert.deepEqual(parseAction('press Shift+Tab "a title" Enter'), {
    verb: 'press',
    target: 'Shift+Tab "a title" Enter',
    keys: [{ key: 'Shift+Tab' }, { text: 'a title' }, { key: 'Enter' }],
    raw: 'press Shift+Tab "a title" Enter',
  });
  assert.equal(parseAction('#just-a-selector'), null);
  assert.equal(parseAction('frobnicate #x'), null);
});

test('parseAssertion: count parses right-to-left so selectors may contain spaces', () => {
  const a = parseAssertion('count #board .task >= 3');
  assert.equal(a?.selector, '#board .task');
  assert.equal(a?.op, '>=');
  assert.equal(a?.n, 3);
  assert.equal(parseAssertion('count #x'), null); // malformed → null
});

test('parseAssertion: text matcher (regex vs substring) and eval', () => {
  const re = parseAssertion('text #summary ~ /\\d+ done/');
  assert.equal(re?.kind, 'text');
  assert.equal(re?.selector, '#summary');
  assert.deepEqual(re?.matcher, { type: 'regex', value: '\\d+ done' });

  const sub = parseAssertion('text #badge ~ "COMPLETE"');
  assert.deepEqual(sub?.matcher, { type: 'substr', value: 'COMPLETE' });

  const ev = parseAssertion('eval document.querySelectorAll(".task").length === 3');
  assert.equal(ev?.kind, 'eval');
  assert.equal(ev?.expr, 'document.querySelectorAll(".task").length === 3');
});

test('parseMatcher: regex, quoted substring, bare substring', () => {
  assert.deepEqual(parseMatcher('/a.b/'), { type: 'regex', value: 'a.b' });
  assert.deepEqual(parseMatcher('"hi"'), { type: 'substr', value: 'hi' });
  assert.deepEqual(parseMatcher('plain words'), { type: 'substr', value: 'plain words' });
});

test('visible/hidden/focused keep the whole remainder as the selector (spaces allowed)', () => {
  assert.equal(parseAssertion('visible #board .task.done')?.selector, '#board .task.done');
  assert.equal(parseAssertion('hidden .empty')?.kind, 'hidden');
  assert.deepEqual(parseAssertion('focused .task .done-btn'), { kind: 'focused', selector: '.task .done-btn', raw: 'focused .task .done-btn' });
});

test('a page script reads press with the key grammar a terminal script reads it with, and drops a malformed one', () => {
  const [step] = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **Keys**\n   \`press Tab Shift+Tab Enter Escape\`\n   \`press "open\`\n   \`press\`\n`).steps;
  assert.deepEqual(step.actions, [parseAction('press Tab Shift+Tab Enter Escape', 'terminal')]);
  assert.deepEqual(step.actions[0].keys, [{ key: 'Tab' }, { key: 'Shift+Tab' }, { key: 'Enter' }, { key: 'Escape' }]);
  assert.deepEqual(step.droppedCodes, ['press "open', 'press']);
});

test('a prove line with no recognised assertion stays prose-only', () => {
  const d = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   _Prove:_ just a human note with no check\n`);
  assert.equal(d.steps[0].prove?.assertion, undefined);
  assert.equal(d.steps[0].prove?.prose, 'just a human note with no check');
});

test('missing title / start / steps each throw', () => {
  assert.throws(() => parseDemoScript('**Start:** /\n## Steps\n1. **s**\n'), /missing "# Demo/);
  assert.throws(() => parseDemoScript('# Demo: X\n## Steps\n1. **s**\n'), /missing "\*\*Start/);
  assert.throws(() => parseDemoScript('# Demo: X\n**Start:** /\n'), /no steps/);
});

test('slugify', () => {
  assert.equal(slugify('Task Board — add → done'), 'task-board-add-done');
  assert.equal(slugify('  Hello, World!  '), 'hello-world');
});

test('outputSlug keeps an id intact (dots survive), unlike slugify', () => {
  assert.equal(outputSlug('checkout.v2.1-happy-path'), 'checkout.v2.1-happy-path');
  assert.equal(slugify('checkout.v2.1-happy-path'), 'checkout-v2-1-happy-path'); // the flattening slugify does
  assert.equal(outputSlug('task-board'), 'task-board');
  assert.equal(outputSlug('My Demo (v2)!'), 'my-demo-v2');
  assert.equal(outputSlug('..leading-dots'), 'leading-dots');
});

// ── The generic demo:capture dialect is a subset ──
//
// A raw draft in the generic format must parse and run unedited, so a flow can capture
// first and sharpen after. This fixture is written in the UNADAPTED format: an
// `**Auth:**` line, prose-only proofs, no start query, no directives, and a trailing
// `## Scrutiny` section.
const GENERATED = `# Demo: Generic draft

**Start:** /
**Auth:** yes

## Steps

1. **The app opens on the dashboard**
   Navigate to the app.
   _Prove:_ The dashboard is visible with a header
   _Fail if:_ The page is blank

2. **A row lands in the table**
   Wait for the first row.
   _Prove:_ A row is rendered
   _Fail if:_ The table is still empty

## Scrutiny

- Numbers are per-item, not one lumped total
- No destructive action is triggered
`;

test('generic dialect: **Auth:** is accepted and kept out of the cover subtitle', () => {
  const d = parseDemoScript(GENERATED);
  assert.equal(d.title, 'Generic draft');
  assert.equal(d.start, '/');
  assert.equal(d.description, ''); // NOT "Auth: yes"
});

test('generic dialect: an unadapted draft still yields runnable steps (manual proofs)', () => {
  const d = parseDemoScript(GENERATED);
  assert.equal(d.steps.length, 2);
  assert.deepEqual(d.steps[0].actions, []);
  assert.equal(d.steps[0].prove?.assertion, undefined);
  assert.equal(d.steps[0].prove?.prose, 'The dashboard is visible with a header');
  assert.equal(d.steps[1].failIf?.prose, 'The table is still empty');
});

test('## Scrutiny parses into its own list, never into the last step', () => {
  const d = parseDemoScript(GENERATED);
  assert.deepEqual(d.scrutiny, ['Numbers are per-item, not one lumped total', 'No destructive action is triggered']);
  assert.equal(d.steps[1].description, 'Wait for the first row.');
});

test('scrutiny: wrapped bullets join their item, code spans keep their text', () => {
  const d = parseDemoScript(
    `# Demo: X\n**Start:** /\n## Steps\n1. **s**\n## Scrutiny\n- The \`#summary\` panel reports\n  every item\n- Second item\n`,
  );
  assert.deepEqual(d.scrutiny, ['The #summary panel reports every item', 'Second item']);
});

test('a section after ## Steps closes the steps block instead of leaking into a step', () => {
  const d = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   real prose\n## Notes\nignored prose here\n`);
  assert.equal(d.steps.length, 1);
  assert.equal(d.steps[0].description, 'real prose');
  assert.deepEqual(d.scrutiny, []);
});

test('a script with no ## Scrutiny section yields an empty list', () => {
  assert.deepEqual(parseDemoScript(SCRIPT).scrutiny, []);
});

// ── Terminal scripts ──
//
// A script that declares `**Terminal:**` drives a shell in the engine's terminal. It needs
// no `**Start:**`, and the parser reads only the terminal's verbs and assertions in it, as
// it reads only a page's in a page script.

const TERMINAL = `# Demo: A shell

**Terminal:** 80x24

## Steps

1. **A command runs**
   \`run ls -la\`
   _Prove:_ it lists the file — \`screen ~ "tasks.md"\`
   _Fail if:_ it failed — \`exit > 0\`

2. **Keys reach a full-screen program**
   \`press ArrowDown "two words" Control+C\`
   \`waitForScreen /^done$/\`
   \`click #ignored\`
   \`wait 200\`
   _Prove:_ the cursor sits on the last row — \`cursor -1 3\`

3. **The status bar reads**
   _Prove:_ the bottom row counts it — \`row -1 ~ /2 of 3 done/\`
`;

test('terminal: **Terminal:** declares the surface and its size, and no **Start:** is needed', () => {
  const d = parseDemoScript(TERMINAL);
  assert.deepEqual(d.terminal, { cols: 80, rows: 24 });
  assert.equal(d.start, '');
  assert.equal(surfaceOf(d), 'terminal');
  assert.equal(surfaceOf(parseDemoScript(SCRIPT)), 'page');
  assert.equal(parseDemoScript(SCRIPT).terminal, undefined);
});

test('terminal: the size is optional, may sit in backticks, and is refused outside the range', () => {
  assert.deepEqual(parseTerminalSpec(''), DEFAULT_TERMINAL);
  assert.deepEqual(parseTerminalSpec('`120x40`'), { cols: 120, rows: 40 });
  assert.deepEqual(parseTerminalSpec('132 × 43'), { cols: 132, rows: 43 });
  assert.throws(() => parseTerminalSpec('wide'), /takes an optional size, <cols>x<rows> \(got "wide"\)/);
  assert.throws(() => parseTerminalSpec('10x24'), /10x24 is out of range/);
  assert.throws(() => parseTerminalSpec('80x101'), /80x101 is out of range/);
  assert.throws(() => parseDemoScript('# Demo: X\n**Terminal:** huge\n## Steps\n1. **s**\n'), /\*\*Terminal:\*\* takes an optional size/);
});

test('terminal: run, press, waitForScreen and wait parse; a page directive stays prose', () => {
  const [one, two] = parseDemoScript(TERMINAL).steps;
  assert.deepEqual(one.actions, [{ verb: 'run', target: 'ls -la', raw: 'run ls -la' }]);
  assert.deepEqual(
    two.actions.map((a) => a.verb),
    ['press', 'waitForScreen', 'wait'],
  );
  assert.deepEqual(two.actions[0].keys, [{ key: 'ArrowDown' }, { text: 'two words' }, { key: 'Control+C' }]);
  assert.deepEqual(two.actions[1].matcher, { type: 'regex', value: '^done$' });
  assert.deepEqual(two.droppedCodes, ['click #ignored']);
});

test('terminal: a page script keeps the verbs only a terminal has as prose', () => {
  const d = parseDemoScript(`# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   Then \`run npm test\` and \`waitForScreen /ok/\`.\n   \`click #add\`\n`);
  assert.deepEqual(
    d.steps[0].actions.map((a) => a.verb),
    ['click'],
  );
  assert.deepEqual(d.steps[0].droppedCodes, ['run npm test', 'waitForScreen /ok/']);
  assert.equal(parseAction('run ls'), null);
  assert.equal(parseAction('click #a', 'terminal'), null);
  assert.equal(parseAction('run', 'terminal'), null);
  assert.equal(parseAction('waitForScreen', 'terminal'), null);
});

test('terminal: screen, row, cursor and exit assertions parse; a page assertion does not', () => {
  const [one, two, three] = parseDemoScript(TERMINAL).steps;
  assert.deepEqual(one.prove?.assertion, { kind: 'screen', matcher: { type: 'substr', value: 'tasks.md' }, raw: 'screen ~ "tasks.md"' });
  assert.deepEqual(one.failIf?.assertion, { kind: 'exit', op: '>', n: 0, raw: 'exit > 0' });
  assert.deepEqual(two.prove?.assertion, { kind: 'cursor', row: -1, col: 3, raw: 'cursor -1 3' });
  assert.deepEqual(three.prove?.assertion, { kind: 'row', row: -1, matcher: { type: 'regex', value: '2 of 3 done' }, raw: 'row -1 ~ /2 of 3 done/' });

  assert.equal(parseAssertion('visible #board', 'terminal'), null);
  assert.equal(parseAssertion('focused #board', 'terminal'), null);
  assert.equal(parseAssertion('screen ~ x'), null);
  for (const bad of ['screen x', 'row 0 ~ x', 'row one ~ x', 'cursor 0 1', 'cursor 1 0', 'cursor 1', 'exit 0', 'exit != 0', 'exit == -1']) {
    assert.equal(parseAssertion(bad, 'terminal'), null, bad);
  }
});

test('terminal: press splits keys from quoted text, and refuses an open or empty quote', () => {
  assert.deepEqual(parseKeys('ArrowDown ArrowDown Enter'), [{ key: 'ArrowDown' }, { key: 'ArrowDown' }, { key: 'Enter' }]);
  assert.deepEqual(parseKeys('":wq" Enter " "'), [{ text: ':wq' }, { key: 'Enter' }, { text: ' ' }]);
  for (const bad of ['', '"open', '""', '"a"b', 'a"b']) assert.equal(parseKeys(bad), null, bad);
});

// ── A page script's device ──
//
// `**Device:**` names a device as Playwright's registry names it, or a viewport size, and
// `resize` changes the size mid-script. The parser checks a size and keeps a name as
// written, since the registry is the capture's and the linter's to look in.

test('device: **Device:** names a device, kept as written, or a size in CSS pixels', () => {
  assert.deepEqual(parseDemoScript('# Demo: X\n**Start:** /\n**Device:** iPhone 15\n## Steps\n1. **s**\n').device, { name: 'iPhone 15' });
  assert.deepEqual(parseDemoScript('# Demo: X\n**Device:** `375x812`\n**Start:** /\n## Steps\n1. **s**\n').device, { viewport: { width: 375, height: 812 } });
  assert.deepEqual(parseDeviceSpec('1280 × 800'), { viewport: { width: 1280, height: 800 } });
  assert.deepEqual(parseDeviceSpec('  Galaxy S9+ '), { name: 'Galaxy S9+' });
  assert.equal(parseDemoScript(SCRIPT).device, undefined);
  assert.equal(parseDemoScript('# Demo: X\n**Start:** /\n**Device:** iPhone 15\n## Steps\n1. **s**\n').description, '', 'the line stays out of the cover subtitle');
});

test('device: a size that does not parse or has a side out of range is refused, and so is an empty line', () => {
  const refused = /demo script: \*\*Device:\*\* takes a device Playwright names, such as "iPhone 15", or a size, <width>x<height>, each side from 200 to 3840 CSS pixels \(got "/;
  for (const bad of ['375x', '375 by 812', '375x812px', '199x812', '375x3841', '']) assert.throws(() => parseDeviceSpec(bad), refused, bad);
  assert.throws(() => parseDemoScript('# Demo: X\n**Start:** /\n**Device:** 3750x8120\n## Steps\n1. **s**\n'), /\(got "3750x8120"\)$/);
  assert.deepEqual(parseViewportSize('200x3840'), { width: 200, height: 3840 });
  for (const bad of ['3841x200', '200x199', '-375x812', '375.5x812', 'x812']) assert.equal(parseViewportSize(bad), null, bad);
});

test('device: resize takes a size, and one that does not parse is kept for the linter', () => {
  const [step] = parseDemoScript('# Demo: X\n**Start:** /\n## Steps\n1. **s**\n   `resize 1280x800`\n   `resize 1280x80O`\n   The `resize` event fires.\n').steps;
  assert.deepEqual(step.actions, [{ verb: 'resize', target: '1280x800', size: { width: 1280, height: 800 }, raw: 'resize 1280x800' }]);
  assert.deepEqual(step.droppedCodes, ['resize 1280x80O', 'resize']);
});

test('device: a terminal script keeps a **Device:** line for the linter, and reads resize as prose', () => {
  const d = parseDemoScript('# Demo: X\n**Terminal:** 80x24\n**Device:** iPhone 15\n## Steps\n1. **s**\n   `run ls`\n   `resize 375x812`\n');
  assert.deepEqual(d.device, { name: 'iPhone 15' });
  assert.deepEqual(d.steps[0].droppedCodes, ['resize 375x812']);
  assert.equal(parseAction('resize 375x812', 'terminal'), null);
});

test('deviceName finds a registry name regardless of case and spacing; unknownDevice names the nearest three', () => {
  const names = ['iPhone 15', 'iPhone 15 Pro', 'Pixel 7', 'iPad Mini'];
  assert.equal(deviceName('iPhone 15', names), 'iPhone 15');
  assert.equal(deviceName('iphone   15 PRO', names), 'iPhone 15 Pro');
  assert.equal(deviceName('iPhone15', names), null);
  assert.equal(unknownDevice('iPhone15', names), '**Device:** "iPhone15" is not a device Playwright describes; the nearest it describes are "iPhone 15", "iPhone 15 Pro", "Pixel 7"');
  assert.equal(unknownDevice('Pixel 8', names).split('; ')[1], 'the nearest it describes are "Pixel 7", "iPhone 15", "iPad Mini"');
  assert.equal(unknownDevice('iPhone 15', []), '**Device:** "iPhone 15" is not a device Playwright describes');
});
