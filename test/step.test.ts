// Tests for the step runner (runStep in src/browser.ts), the one function every capture
// drives its steps through.
//
// A step's actions run first, then its proof is checked against the live page: a
// `_Prove:_` assertion must hold within PROVE_TIMEOUT, a `_Fail if:_` assertion that
// matches overrides it, and a step with neither records a manual proof. A driver's
// `beforeActions` hook runs between the step's header line and its actions. These tests
// pin that against a real page, and pin that proof mode and the screenshot capture report
// the same script's steps alike.
//
// A page's `press` sends each key wherever the page's focus is, so Tab and Shift+Tab move
// focus, Enter and Escape reach the control that has it, and the browser draws the focus
// ring that keys move. `focused` proves where focus is. The bundled keyboard demo drives
// the sample app that way, and each of its proofs holds.
//
// They need a headless Chromium and skip without one (see browser-fixture.ts).

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDemoScript, parseAction, parseAssertion } from '../src/demo-script.ts';
import { runStep, runAction, checkAssertion, joinUrl, PROVE_TIMEOUT } from '../src/browser.ts';
import { ensureServer } from '../src/server.ts';
import { launchBrowser, serveSite, scratchDir, writeFiles, stubFfmpeg, runCli, stepLines, pixelsApart, REPO } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

/** A page with a button that appends an item to a list. */
const APP = `<!doctype html><html><body>
<button id="add">Add</button>
<ul id="items"></ul>
<script>
  document.getElementById('add').addEventListener('click', () => {
    const li = document.createElement('li');
    li.className = 'item';
    li.textContent = 'item';
    document.getElementById('items').appendChild(li);
  });
</script>
</body></html>`;

/** One step per outcome that resolves at once: a proof that holds, a fail-if that overrides it, a manual proof. */
const SCRIPT = `# Demo: Step runner

**Start:** \`/\`

## Steps

1. **An action runs before the proof is checked**
   \`click #add\`
   _Prove:_ one item is listed — \`count .item == 1\`

2. **A matching fail-if overrides a proof that held**
   _Prove:_ the item shows — \`visible .item\`
   _Fail if:_ any item is listed — \`count .item >= 1\`

3. **A step with no machine assertion records a manual proof**
   _Prove:_ the list reads well
`;

/** A page driven by keys: a field whose Enter shows what was typed, a button that opens a modal dialog, and the dialog. */
const KEYS_APP = `<!doctype html><html><body>
<input id="field">
<button id="open">Open</button>
<p id="said"></p>
<dialog id="dialog"><button id="close">Close</button></dialog>
<script>
  const dialog = document.getElementById('dialog');
  document.getElementById('open').addEventListener('click', () => dialog.showModal());
  document.getElementById('close').addEventListener('click', () => dialog.close());
  document.getElementById('field').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('said').textContent = e.target.value;
  });
</script>
</body></html>`;

/** One step per key of a keyboard flow, each proving the focus it moves or the reaction it causes. */
const KEYS_SCRIPT = `# Demo: Keys

**Start:** \`/\`

## Steps

1. **Tab moves focus into the field, and a quoted string types there**
   \`press Tab "hello" Enter\`
   _Prove:_ Enter in the field shows what was typed — \`text #said ~ "hello"\`

2. **Tab moves focus to the button**
   \`press Tab\`
   _Prove:_ the button has focus — \`focused #open\`

3. **Enter presses the button, and the dialog takes focus**
   \`press Enter\`
   _Prove:_ focus moved into the dialog — \`focused #close\`

4. **Escape closes the dialog, and focus returns to the button**
   \`press Escape\`
   _Prove:_ the button has focus again — \`focused #open\`
   _Fail if:_ the dialog still shows — \`visible #dialog\`

5. **Shift+Tab moves focus back to the field**
   \`press Shift+Tab\`
   _Prove:_ the field has focus — \`focused #field\`
`;

// Each test drives a page and a site of its own, so they run side by side.
describe('the step runner', { concurrency: true, skip }, () => {
  test('runStep: actions run first, a held proof passes, a matching fail-if fails it, no assertion is manual', async () => {
    const site = await serveSite({ 'index.html': APP });
    const page = await browser!.newPage();
    try {
      await page.goto(joinUrl(site.baseUrl, '/'));
      const demo = parseDemoScript(SCRIPT);
      const lines: string[] = [];
      const results = [];
      for (const step of demo.steps) results.push(await runStep(page, site.baseUrl, step, demo.steps.length, false, (m) => lines.push(m)));

      assert.deepEqual(results, [
        { proved: true, manual: false, reason: '' },
        { proved: false, manual: false, reason: '_Fail if:_ condition matched: `count .item >= 1`' },
        { proved: true, manual: true, reason: '' },
      ]);
      assert.deepEqual(lines, [
        'step 1/3: An action runs before the proof is checked',
        '  ✓ proof held',
        'step 2/3: A matching fail-if overrides a proof that held',
        '  ✗ _Fail if:_ condition matched: `count .item >= 1`',
        'step 3/3: A step with no machine assertion records a manual proof',
        '  ✓ (manual — no machine assertion)',
      ]);
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('runStep: beforeActions runs after the step header and before the actions, and when it fails the header is the last line', async () => {
    const site = await serveSite({ 'index.html': APP });
    const page = await browser!.newPage();
    try {
      await page.goto(joinUrl(site.baseUrl, '/'));
      const [step] = parseDemoScript(SCRIPT).steps;
      const lines: string[] = [];
      const log = (m: string): void => {
        lines.push(m);
      };
      const result = await runStep(page, site.baseUrl, step, 3, false, log, async () => {
        lines.push(`before: ${await page.locator('.item').count()} item(s)`);
      });
      assert.deepEqual(result, { proved: true, manual: false, reason: '' });
      assert.deepEqual(lines, ['step 1/3: An action runs before the proof is checked', 'before: 0 item(s)', '  ✓ proof held']);

      lines.length = 0;
      const drawFails = async (): Promise<void> => {
        throw new Error('the page closed');
      };
      await assert.rejects(runStep(page, site.baseUrl, step, 3, false, log, drawFails), { message: 'the page closed' });
      assert.deepEqual(lines, ['step 1/3: An action runs before the proof is checked']);
      assert.equal(await page.locator('.item').count(), 1, 'the actions did not run');
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('runStep: a proof that never holds fails the step once PROVE_TIMEOUT has passed', async () => {
    const site = await serveSite({ 'index.html': APP });
    const page = await browser!.newPage();
    try {
      await page.goto(joinUrl(site.baseUrl, '/'));
      const [step] = parseDemoScript(`# Demo: X\n\n**Start:** \`/\`\n\n## Steps\n\n1. **Nothing adds an item**\n   _Prove:_ an item is listed — \`count .item >= 1\`\n`).steps;
      const lines: string[] = [];
      const t0 = Date.now();
      const result = await runStep(page, site.baseUrl, step, 1, false, (m) => lines.push(m));
      assert.ok(Date.now() - t0 >= PROVE_TIMEOUT, 'the assertion is polled for the whole timeout');
      assert.deepEqual(result, { proved: false, manual: false, reason: '_Prove:_ did not hold: `count .item >= 1`' });
      assert.equal(lines.at(-1), '  ✗ _Prove:_ did not hold: `count .item >= 1`');
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('runStep: a page press sends each key wherever the page focus is, and focused proves where that is', async () => {
    const site = await serveSite({ 'index.html': KEYS_APP });
    const page = await browser!.newPage();
    try {
      await page.goto(joinUrl(site.baseUrl, '/'));
      const demo = parseDemoScript(KEYS_SCRIPT);
      const lines: string[] = [];
      const results = [];
      for (const step of demo.steps) results.push(await runStep(page, site.baseUrl, step, demo.steps.length, false, (m) => lines.push(m)));
      assert.deepEqual(results, Array(5).fill({ proved: true, manual: false, reason: '' }), lines.join('\n'));

      // One element has focus, so focused holds for a selector when any of its matches has it.
      await runAction(page, site.baseUrl, parseAction('press Tab')!, false, () => {});
      const focused = (selector: string): Promise<boolean> => checkAssertion(page, parseAssertion(`focused ${selector}`)!);
      assert.equal(await focused('input, button'), true, 'the button, the second match, has focus');
      assert.equal(await focused('input'), false);
      assert.equal(await focused('#missing'), false);
    } finally {
      await page.close();
      await site.close();
    }
  });

  test("a page press moves focus as a user's keys do, so the browser draws the focus ring a capture shows, which a click does not", async () => {
    const site = await serveSite({ 'index.html': KEYS_APP });
    const page = await browser!.newPage();
    try {
      await page.goto(joinUrl(site.baseUrl, '/'));
      const box = (await page.locator('#open').boundingBox())!;
      const around = { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 };
      const unfocused = await page.screenshot({ clip: around });
      const ringed = (): Promise<boolean> => page.evaluate(() => document.activeElement?.matches('#open:focus-visible') ?? false);

      await page.click('#open');
      await page.evaluate(() => (document.getElementById('dialog') as HTMLDialogElement).close());
      assert.equal(await checkAssertion(page, parseAssertion('focused #open')!), true, 'the click focused the button');
      assert.equal(await ringed(), false, 'a click draws no ring');

      await runAction(page, site.baseUrl, parseAction('press Shift+Tab Tab')!, false, () => {});
      assert.equal(await checkAssertion(page, parseAssertion('focused #open')!), true, 'the keys moved focus off the button and back');
      assert.equal(await ringed(), true, 'keys draw the ring');
      // The ring runs round the button: far more pixels than the few that anti-aliasing can shift.
      assert.ok((await pixelsApart(page, unfocused, await page.screenshot({ clip: around }), 32)) > 40, 'the capture shows no ring round the button');
    } finally {
      await page.close();
      await site.close();
    }
  });

  test('the bundled keyboard demo drives the sample app with Tab, Shift+Tab, Enter and Escape, and each step proves what it shows', async () => {
    const server = await ensureServer({ serveDir: path.join(REPO, 'examples', 'sample-app'), log: () => {} });
    const page = await browser!.newPage();
    try {
      const demo = parseDemoScript(readFileSync(path.join(REPO, 'demos', 'keyboard.md'), 'utf8'));
      const pressed = new Set(demo.steps.flatMap((s) => s.actions.flatMap((a) => (a.keys ?? []).flatMap((k) => ('key' in k ? [k.key] : [])))));
      for (const key of ['Tab', 'Shift+Tab', 'Enter', 'Escape']) assert.ok(pressed.has(key), `the demo presses ${key}`);
      await page.goto(joinUrl(server.baseUrl, demo.start));
      const lines: string[] = [];
      for (const step of demo.steps) {
        const { proved, manual } = await runStep(page, server.baseUrl, step, demo.steps.length, false, (m) => lines.push(m));
        assert.ok(proved && !manual, lines.join('\n'));
      }
    } finally {
      await page.close();
      await server.stop();
    }
  });

  test('proof mode and the screenshot capture report the same steps alike, through the runner', async () => {
    const { dir, cleanup } = scratchDir();
    try {
      writeFiles(dir, { 'site/index.html': APP, 'demo.md': SCRIPT });
      const ffmpeg = stubFfmpeg(dir);
      const common = [path.join(dir, 'demo.md'), '--serve-dir', path.join(dir, 'site')];
      const env = { ...process.env, FFMPEG_BIN: ffmpeg, OPENAI_API_KEY: '' };
      const proof = await runCli(['run', ...common, '--mode', 'proof', '--no-narrate', '-o', path.join(dir, 'out.mp4')], { cwd: dir, env });
      const shot = await runCli(['screenshot', ...common, '-o', path.join(dir, 'out.png')], { cwd: dir, env });

      const expected = [
        'step 1/3: An action runs before the proof is checked',
        '  ✓ proof held',
        'step 2/3: A matching fail-if overrides a proof that held',
        '  ✗ _Fail if:_ condition matched: `count .item >= 1`',
        'step 3/3: A step with no machine assertion records a manual proof',
        '  ✓ (manual — no machine assertion)',
      ];
      assert.equal(proof.code, 3, `a failed proof still saves the video\n${proof.stdout}${proof.stderr}`);
      assert.deepEqual(stepLines(proof.stdout), expected);
      assert.equal(shot.code, 3, `a failed proof still saves the screenshot\n${shot.stdout}${shot.stderr}`);
      assert.deepEqual(stepLines(shot.stdout), expected);
      assert.ok(existsSync(path.join(dir, 'out.png')));

      const [kept] = readdirSync(path.join(dir, '.captures'));
      const issues = JSON.parse(readFileSync(path.join(dir, '.captures', kept, 'issues.json'), 'utf8'));
      assert.equal(issues.length, 1);
      assert.equal(issues[0].step, 2);
      assert.ok(issues[0].description.endsWith(' — _Fail if:_ condition matched: `count .item >= 1`'), issues[0].description);
    } finally {
      cleanup();
    }
  });
});
