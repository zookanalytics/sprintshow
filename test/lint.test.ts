// Tests for the demo-script linter (src/lint.ts).
//
// The rules make the gap between a generated draft and a proving demo explicit before a
// capture run, so they are pinned against two fixtures: a raw draft (should light up) and
// an adapted script (should be quiet). The environment is passed in explicitly, so
// nothing here shells out to git.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDemoScript } from '../src/demo-script.ts';
import { lintDemo, demoScenarioOf, looksLikeDirective, looksLikeAssertion, type LintEnv } from '../src/lint.ts';

/** A well-adapted script: five steps, all driving the page, machine assertions everywhere. */
const ADAPTED_SCRIPT = `# Demo: Adapted

**Start:** \`/?seed=board\`

## Steps

${[1, 2, 3, 4, 5]
  .map(
    (i) => `${i}. **Step ${i} does something observable**
   \`waitFor #board\`
   _Prove:_ the board shows — \`visible #board\`
`,
  )
  .join('\n')}`;

/** A raw draft: generic route, prose proofs, no actions, 2 steps. */
const DRAFT = `# Demo: Draft

**Start:** /
**Auth:** yes

## Steps

1. **A first thing happens**
   Navigate to the app.
   _Prove:_ The dashboard is visible
   _Fail if:_ The page is blank

2. **A second thing happens**
   Wait a bit.
   _Prove:_ A row appears
`;

const ENV: LintEnv = { scenarios: [], lfsInstalled: true, lfsTracked: true, narration: false, devices: ['iPhone 15', 'Pixel 7', 'iPad Mini'] };

const messagesFor = (md: string, env: Partial<LintEnv> = {}) => lintDemo(parseDemoScript(md), { ...ENV, ...env });

test('demoScenarioOf pulls the scenario out of the start URL', () => {
  assert.equal(demoScenarioOf('/?demo=board&anim=off'), 'board');
  assert.equal(demoScenarioOf('/?anim=off&demo=x'), 'x');
  assert.equal(demoScenarioOf('/'), null);
});

test('an adapted script produces no errors and no warnings', () => {
  const findings = messagesFor(ADAPTED_SCRIPT);
  assert.deepEqual(
    findings.filter((f) => f.severity !== 'info'),
    [],
  );
  assert.equal(findings.filter((f) => f.severity === 'info').length, 1);
});

test('a raw draft is flagged: no interaction, thin step count, prose-only proofs', () => {
  const findings = messagesFor(DRAFT);
  assert.equal(findings.filter((f) => f.severity === 'error').length, 0); // nothing fatal — it WOULD run
  const warns = findings.filter((f) => f.severity === 'warn');
  assert.match(warns[0].message, /no query and no step performs an action/);
  assert.ok(warns.some((f) => /2 steps — under 5/.test(f.message)));
  assert.equal(warns.filter((f) => /`_Prove:_` is prose only/.test(f.message)).length, 2);
  assert.equal(warns.filter((f) => /`_Fail if:_` is prose only/.test(f.message)).length, 1);
});

test('a start URL with a query is not flagged as idle, even with no actions', () => {
  const md = `# Demo: X\n\n**Start:** \`/?seed=board\`\n\n## Steps\n\n1. **A seeded view renders**\n   _Prove:_ the board shows — \`visible #board\`\n`;
  assert.equal(messagesFor(md).filter((f) => /no query and no step performs an action/.test(f.message)).length, 0);
});

test('a step that clicks is not flagged as idle, even with no start query', () => {
  const md = `# Demo: X\n\n**Start:** /\n\n## Steps\n\n1. **A control is clicked**\n   \`click #add\`\n   _Prove:_ a task renders — \`count .task >= 1\`\n`;
  assert.equal(messagesFor(md).filter((f) => /no query and no step performs an action/.test(f.message)).length, 0);
});

test('a page script that drives the page with keys and proves where focus is is quiet, and so is the keyboard sample', () => {
  const steps = [1, 2, 3, 4, 5].map((i) => `${i}. **Key ${i} moves focus**\n   \`press Tab\`\n   _Prove:_ a button has focus — \`focused button\`\n`);
  assert.deepEqual(
    messagesFor(`# Demo: X\n\n**Start:** /\n\n## Steps\n\n${steps.join('\n')}`).filter((f) => f.severity !== 'info'),
    [],
  );
  const sample = readFileSync(path.join(import.meta.dirname, '..', 'demos', 'keyboard.md'), 'utf8');
  assert.deepEqual(
    messagesFor(sample).filter((f) => f.severity !== 'info'),
    [],
  );
});

test('a press whose keys do not parse is reported in a page script as in a terminal script', () => {
  const findings = (head: string): string[] =>
    messagesFor(`# Demo: X\n\n${head}\n\n## Steps\n\n1. **Keys that do not parse**\n   \`press "open\`\n`)
      .filter((f) => f.step === 1 && f.message.startsWith('`press "open`'))
      .map((f) => f.message);
  assert.deepEqual(findings('**Start:** /'), ['`press "open` has malformed arguments: a quote is left open or sits inside a word, a string is empty, or there are no keys — it is IGNORED at capture time.']);
  assert.deepEqual(findings('**Start:** /'), findings('**Terminal:**'));
});

test('an unknown scenario is an ERROR only when a registry is supplied', () => {
  const md = ADAPTED_SCRIPT.replace('/?seed=board', '/?demo=typo-scenario');
  // No registry (default): the scenario check is off — no error.
  assert.equal(messagesFor(md).filter((f) => f.severity === 'error').length, 0);
  // With a registry that does not include it: an error naming what is available.
  const withRegistry = messagesFor(md, { scenarios: ['board', 'list'] });
  const errors = withRegistry.filter((f) => f.severity === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /not a known scenario/);
  assert.match(errors[0].message, /board/);
});

test("a typo'd directive is reported, prose code spans are not", () => {
  const md = `# Demo: X

**Start:** \`/?seed=board\`

## Steps

1. **A step whose wait never happens**
   \`waitfor #board\`
   Driven by the \`?seed=\` entrypoint against \`#board\`, run with \`npm run dev\`.
   _Prove:_ the board shows — \`visible #board\`
`;
  const warns = messagesFor(md).filter((f) => f.severity === 'warn');
  const dropped = warns.filter((f) => /is not a known directive/.test(f.message));
  assert.equal(dropped.length, 1);
  assert.match(dropped[0].message, /waitfor #board/);
});

test('a _Prove:_ whose assertion did not parse reads differently from honest prose', () => {
  const md = `# Demo: X

**Start:** \`/?seed=board\`

## Steps

1. **A step with a broken check**
   _Prove:_ three tasks land — \`count .task\`
`;
  const warns = messagesFor(md).filter((f) => f.severity === 'warn' && f.step === 1);
  assert.ok(warns.some((f) => /not a recognised assertion — the step is NOT checked/.test(f.message)));
});

test('an over-long caption is flagged (it clips on screen)', () => {
  const long = 'x'.repeat(81);
  const md = `# Demo: X\n\n**Start:** \`/?seed=board\`\n\n## Steps\n\n1. **${long}**\n   _Prove:_ shows — \`visible #a\`\n`;
  assert.ok(messagesFor(md).some((f) => /caption is 81 chars/.test(f.message)));
});

test('LFS findings: untracked output, and tracked-but-no-git-lfs', () => {
  const untracked = messagesFor(ADAPTED_SCRIPT, { lfsTracked: false });
  assert.ok(untracked.some((f) => /not matched by an LFS filter/.test(f.message)));

  const noBinary = messagesFor(ADAPTED_SCRIPT, { lfsTracked: true, lfsInstalled: false });
  assert.ok(noBinary.some((f) => /git-lfs is NOT installed/.test(f.message)));

  assert.equal(messagesFor(ADAPTED_SCRIPT).filter((f) => /LFS|git-lfs/.test(f.message)).length, 0);
});

test('the info line reports whether the capture will narrate', () => {
  assert.match(messagesFor(ADAPTED_SCRIPT, { narration: true }).at(-1)?.message ?? '', /narrate/);
  assert.match(messagesFor(ADAPTED_SCRIPT, { narration: false }).at(-1)?.message ?? '', /SILENT MP4/);
});

test('looksLikeDirective: case slips and Playwright habits yes, prose no', () => {
  assert.equal(looksLikeDirective('waitfor #x'), true);
  assert.equal(looksLikeDirective('Click #add'), true);
  assert.equal(looksLikeDirective('fill #input hello'), true);
  assert.equal(looksLikeDirective('#board'), false);
  assert.equal(looksLikeDirective('?seed=board'), false);
  assert.equal(looksLikeDirective('npm run dev'), false);
});

// ── Terminal scripts ──
//
// A terminal script is read with the terminal's verbs and assertions, so a page directive
// or assertion in one is dropped as prose. The linter names the surface it belongs to.

/** A five-step terminal script that drives the shell and proves every step. */
const TERMINAL_SCRIPT = `# Demo: Shell

**Terminal:** 80x24

## Steps

${[1, 2, 3, 4, 5]
  .map(
    (i) => `${i}. **Step ${i} runs a command**
   \`run echo ${i}\`
   _Prove:_ it printed — \`screen ~ "${i}"\`
`,
  )
  .join('\n')}`;

test('a terminal script that drives the shell and proves each step is quiet, and so is the sample', () => {
  assert.deepEqual(
    messagesFor(TERMINAL_SCRIPT).filter((f) => f.severity !== 'info'),
    [],
  );
  const sample = readFileSync(path.join(import.meta.dirname, '..', 'demos', 'terminal.md'), 'utf8');
  assert.deepEqual(
    messagesFor(sample).filter((f) => f.severity !== 'info'),
    [],
  );
});

test('a terminal script with no action is flagged, and so is a **Start:** it ignores', () => {
  const idle = messagesFor(`# Demo: X\n\n**Terminal:**\n**Start:** \`/\`\n\n## Steps\n\n1. **The prompt shows**\n   _Prove:_ a prompt — \`row 1 ~ /^\\$/\`\n`);
  assert.ok(idle.some((f) => /no step runs a command or presses a key/.test(f.message)));
  assert.ok(idle.some((f) => /\*\*Start:\*\* `\/` is ignored — a terminal script's shell starts in --cwd/.test(f.message)));
  assert.equal(idle.filter((f) => /no query and no step performs an action/.test(f.message)).length, 0);
});

test("a directive or an assertion of the other surface is named as that surface's", () => {
  const inTerminal = messagesFor(`# Demo: X

**Terminal:**

## Steps

1. **A page directive in a terminal script**
   \`run ls\`
   \`click #add\`
   _Prove:_ the board shows — \`visible #board\`
`).filter((f) => f.step === 1);
  assert.ok(inTerminal.some((f) => /`click #add` is a page directive in a terminal script — it is IGNORED at capture time \(verbs: run, press, waitForScreen, wait\)/.test(f.message)));
  assert.ok(inTerminal.some((f) => /carries `visible #board`, a page assertion in a terminal script — the step is NOT checked. Assertions are screen\/row\/cursor\/exit/.test(f.message)));
  const focusInTerminal = messagesFor(`# Demo: X\n\n**Terminal:**\n\n## Steps\n\n1. **Focus is a page's**\n   \`run ls\`\n   _Prove:_ focus — \`focused #a\`\n`);
  assert.ok(focusInTerminal.some((f) => /carries `focused #a`, a page assertion in a terminal script/.test(f.message)));

  const inPage = messagesFor(`# Demo: X

**Start:** \`/?seed=board\`

## Steps

1. **A terminal directive in a page script**
   \`run npm test\`
   _Prove:_ the tests passed — \`exit == 0\`
`).filter((f) => f.step === 1);
  assert.ok(inPage.some((f) => /`run npm test` is a terminal directive in a page script — it is IGNORED/.test(f.message)));
  assert.ok(inPage.some((f) => /carries `exit == 0`, a terminal assertion in a page script/.test(f.message)));
});

test("a directive of the script's own surface is reported for the arguments that kept it from parsing", () => {
  const warns = messagesFor(`# Demo: X

**Terminal:**

## Steps

1. **Directives whose arguments do not parse**
   \`press "hello\`
   \`press ""\`
   \`press "a"b\`
   \`run\`
   \`waitForScreen\`
   \`Run ls\`
   _Prove:_ a prompt — \`screen ~ "$"\`
`)
    .filter((f) => f.step === 1)
    .map((f) => f.message);
  const malformed = (code: string, why: string): string => `\`${code}\` has malformed arguments: ${why} — it is IGNORED at capture time.`;
  const keys = 'a quote is left open or sits inside a word, a string is empty, or there are no keys';
  for (const message of [
    malformed('press "hello', keys),
    malformed('press ""', keys),
    malformed('press "a"b', keys),
    malformed('run', 'it needs a command line'),
    malformed('waitForScreen', 'it needs a matcher'),
  ]) {
    assert.ok(warns.includes(message), `${message}\nis not among:\n${warns.join('\n')}`);
  }
  // A verb in the wrong case is no verb of the surface, so that span is still unknown.
  assert.deepEqual(
    warns.filter((m) => /is not a known directive/.test(m)),
    ['`Run ls` is not a known directive — it is IGNORED at capture time (verbs: run, press, waitForScreen, wait).'],
  );
});

test('a terminal proof of a row or column past the screen is flagged', () => {
  const md = `# Demo: X\n\n**Terminal:** 40x10\n\n## Steps\n\n1. **Off the edge**\n   \`run true\`\n   _Prove:_ the row — \`row 12 ~ x\`\n   _Fail if:_ the cursor — \`cursor -3 41\`\n`;
  const warns = messagesFor(md).filter((f) => f.step === 1);
  assert.ok(warns.some((f) => /`row 12 ~ x` names row 12, past the terminal's 10 rows/.test(f.message)));
  assert.ok(warns.some((f) => /`cursor -3 41` names column 41, past the terminal's 40 columns/.test(f.message)));
  assert.equal(warns.filter((f) => /names row -3/.test(f.message)).length, 0);
});

test('looksLikeAssertion knows both surfaces', () => {
  assert.equal(looksLikeAssertion('screen x'), true);
  assert.equal(looksLikeAssertion('exit 0'), true);
  assert.equal(looksLikeAssertion('Visible #x'), true);
  assert.equal(looksLikeAssertion('Focused #x'), true);
  assert.equal(looksLikeAssertion('#board'), false);
});

// ── A page script's device ──
//
// A device must be one the registry describes, and a size must be one, wherever it is
// written: on the `**Device:**` line, where the parser refuses a malformed size, or in a
// `resize` step, which the parser drops for the linter to report.

/** ADAPTED_SCRIPT with a `**Device:**` line under its start. */
const onDevice = (device: string): string => ADAPTED_SCRIPT.replace('**Start:** `/?seed=board`', `**Start:** \`/?seed=board\`\n**Device:** ${device}`);

test('a device the registry describes, in any letter case, or a size, lints clean', () => {
  for (const device of ['iPhone 15', 'ipad   mini', '375x812']) {
    assert.deepEqual(
      messagesFor(onDevice(device)).filter((f) => f.severity !== 'info'),
      [],
      device,
    );
  }
});

test('a device the registry does not describe is an ERROR naming the nearest it does', () => {
  const errors = messagesFor(onDevice('Pixel 8')).filter((f) => f.severity === 'error');
  assert.deepEqual(errors, [
    { severity: 'error', step: null, message: '**Device:** "Pixel 8" is not a device Playwright describes; the nearest it describes are "Pixel 7", "iPhone 15", "iPad Mini" — the capture would refuse the script.' },
  ]);
});

test('a malformed size on the **Device:** line is refused as the parser refuses it', () => {
  assert.throws(() => parseDemoScript(onDevice('375x')), /\*\*Device:\*\* takes a device Playwright names/);
});

test('a resize whose size does not parse is an ERROR; a bare resize and a well-formed one are not', () => {
  const md = `# Demo: X

**Start:** \`/?seed=board\`

## Steps

1. **A resize with a typo**
   \`resize 1280x80O\`
   \`resize 99999x800\`
   _Prove:_ the board shows — \`visible #board\`

2. **A resize that names a size, and prose that cites the verb**
   \`resize 1280x800\`
   The \`resize\` handler re-lays the board out.
   _Prove:_ the board shows — \`visible #board\`
`;
  const findings = messagesFor(md).filter((f) => f.step !== null);
  const form = '<width>x<height>, each side from 200 to 3840 CSS pixels';
  assert.deepEqual(
    findings.filter((f) => f.severity === 'error'),
    ['resize 1280x80O', 'resize 99999x800'].map((code) => ({ severity: 'error', step: 1, message: `\`${code}\` does not name a size, ${form} — it is IGNORED at capture time, and the steps after it run at the size before it.` })),
  );
  assert.deepEqual(findings.filter((f) => f.step === 2), [{ severity: 'warn', step: 2, message: `\`resize\` has malformed arguments: it needs a size, ${form} — it is IGNORED at capture time.` }]);
});

test('a terminal script that names a device is warned that its captures ignore it', () => {
  const warns = messagesFor(TERMINAL_SCRIPT.replace('**Terminal:** 80x24', '**Terminal:** 80x24\n**Device:** Nokia 3310')).filter((f) => f.severity !== 'info');
  assert.deepEqual(warns, [
    { severity: 'warn', step: null, message: "**Device:** is ignored — a terminal script is filmed in the engine's own frame, and its size is its **Terminal:** columns and rows." },
  ]);
});
