// Tests for the pure demo-script parser (src/demo-script.ts).
//
//   node --test "test/**/*.test.ts"
//
// The parser is the contract between a human-legible walkthrough and the deterministic
// driver, so the grammar (actions, `_Prove:_`/`_Fail if:_` assertions, matchers) is
// pinned here rather than discovered at capture time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDemoScript, parseAction, parseAssertion, parseMatcher, slugify, outputSlug } from '../src/demo-script.ts';

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

test('visible/hidden keep the whole remainder as the selector (spaces allowed)', () => {
  assert.equal(parseAssertion('visible #board .task.done')?.selector, '#board .task.done');
  assert.equal(parseAssertion('hidden .empty')?.kind, 'hidden');
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
