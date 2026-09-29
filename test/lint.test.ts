// Tests for the demo-script linter (src/lint.ts).
//
// The rules make the gap between a generated draft and a proving demo explicit before a
// capture run, so they are pinned against two fixtures: a raw draft (should light up) and
// an adapted script (should be quiet). The environment is passed in explicitly, so
// nothing here shells out to git.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDemoScript } from '../src/demo-script.ts';
import { lintDemo, demoScenarioOf, looksLikeDirective, type LintEnv } from '../src/lint.ts';

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

const ENV: LintEnv = { scenarios: [], lfsInstalled: true, lfsTracked: true, narration: false };

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
