// Tests for what the two capture commands share in the CLI (src/cli.ts): `run` and
// `screenshot` read their server flags through one mapping, `--port` among them as one
// port or a comma-separated list, and both exit 0 when the output is saved and every
// step's proof held, 3 when it is saved but a proof failed, and 1 when nothing is saved.
// Also, what `surface` prints and how it exits, and what `provision` takes.
//
// The tests that save an output need a headless Chromium and skip without one (see
// browser-fixture.ts). `run` captures in proof mode over a stand-in ffmpeg, so no host
// ffmpeg is needed.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { launchBrowser, runCli, scratchDir, stubFfmpeg, writeFiles, REPO, type CliRun } from './browser-fixture.ts';

const { browser, skip } = await launchBrowser();
after(() => browser?.close());

const SAMPLE = path.join(REPO, 'demos', 'sample.md');
const SAMPLE_APP = path.join(REPO, 'examples', 'sample-app');

const CARD_HTML = '<!doctype html><div class="card">card</div>';

/** A one-step script on the card page, whose proof holds or fails at once as asked. */
function cardScript(proof: 'holds' | 'fails'): string {
  const assertion = proof === 'holds' ? '_Prove:_ the card shows — `visible .card`' : '_Fail if:_ the card shows — `visible .card`';
  return `# Demo: Card\n\n**Start:** \`/card.html\`\n\n## Steps\n\n1. **The card shows**\n   \`waitFor .card\`\n   ${assertion}\n`;
}

/** Run `run --mode proof` and `screenshot` on one script, side by side, each with its own output. */
async function bothCommands(dir: string, script: string, serve: string[]): Promise<{ run: CliRun; shot: CliRun }> {
  const env = { ...process.env, FFMPEG_BIN: stubFfmpeg(dir), OPENAI_API_KEY: '' };
  const [run, shot] = await Promise.all([
    runCli(['run', script, ...serve, '--mode', 'proof', '--no-narrate', '-o', path.join(dir, 'out.mp4')], { cwd: dir, env }),
    runCli(['screenshot', script, ...serve, '-o', path.join(dir, 'out.png')], { cwd: dir, env }),
  ]);
  return { run, shot };
}

describe('the capture commands exit alike when they save their output', { concurrency: true, skip }, () => {
  for (const [proof, code] of [['holds', 0], ['fails', 3]] as const) {
    test(`run and screenshot exit ${code} when the step's proof ${proof === 'holds' ? 'held' : 'failed'}`, async () => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'site/card.html': CARD_HTML, 'demo.md': cardScript(proof) });
        const { run, shot } = await bothCommands(dir, path.join(dir, 'demo.md'), ['--serve-dir', path.join(dir, 'site')]);
        assert.equal(run.code, code, `${run.stdout}${run.stderr}`);
        assert.equal(shot.code, code, `${shot.stdout}${shot.stderr}`);
        assert.ok(existsSync(path.join(dir, 'out.mp4')), 'run saved its video');
        assert.ok(existsSync(path.join(dir, 'out.png')), 'screenshot saved its PNG');
      } finally {
        cleanup();
      }
    });
  }
});

test('run and screenshot exit 1 when nothing is saved', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const { run, shot } = await bothCommands(dir, SAMPLE, []);
    for (const res of [run, shot]) {
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /no server/);
    }
    assert.equal(existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(existsSync(path.join(dir, 'out.png')), false);
  } finally {
    cleanup();
  }
});

test('run and screenshot both refuse a --port that is not a whole number, before anything is served', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const { run, shot } = await bothCommands(dir, SAMPLE, ['--serve-dir', SAMPLE_APP, '--port', 'abc']);
    for (const res of [run, shot]) {
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /server: the port must be a whole number from 1 to 65535 \(got NaN\)/);
      assert.doesNotMatch(res.stdout, /server: serving/);
    }
    assert.equal(existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(existsSync(path.join(dir, 'out.png')), false);
  } finally {
    cleanup();
  }
});

test('run and screenshot both read --port as one port, or as one for each server a run starts, separated by commas', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const app = ['--base-url', 'ios-simulator://00000000-0000-0000-0000-000000000000/com.example.Board'];
    const ios = await bothCommands(dir, path.join(REPO, 'demos', 'ios.md'), [...app, '--port', '4723,8100']);
    const page = await bothCommands(dir, SAMPLE, ['--serve-dir', SAMPLE_APP, '--port', '5173,5174']);
    for (const res of [ios.run, ios.shot]) {
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /ios: --port names a port for each server an iOS app run starts, .* in that order, or none \(got 4723,8100\)/);
    }
    for (const res of [page.run, page.shot]) {
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /server: a page script's server listens on one port, so --port names one \(got 5173,5174\)/);
      assert.doesNotMatch(res.stdout, /server: serving/);
    }
    assert.equal(existsSync(path.join(dir, 'out.mp4')), false);
    assert.equal(existsSync(path.join(dir, 'out.png')), false);
  } finally {
    cleanup();
  }
});

/** A one-step script whose lines between its title and `## Steps` are `head`. */
function scriptWith(head: string): string {
  return `# Demo: Surface\n\n${head}\n\n## Steps\n\n1. **A step**\n   \`wait 10\`\n`;
}

describe('surface prints the surface a script drives, and nothing else, on stdout', { concurrency: true }, () => {
  const cases = [
    ['a page script', '**Start:** `/`', 'page'],
    ['a terminal script with no size', '**Terminal:**', 'terminal'],
    ['a terminal script with a size', '**Terminal:** 80x24', 'terminal'],
    ['a script with **Terminal:** below a ## heading', '**Start:** `/`\n\n## About\n\n**Terminal:** 80x24', 'page'],
  ] as const;
  for (const [name, head, surface] of cases) {
    test(`${name} drives a ${surface}`, async () => {
      const { dir, cleanup } = scratchDir();
      try {
        writeFiles(dir, { 'demo.md': scriptWith(head) });
        const res = await runCli(['surface', 'demo.md'], { cwd: dir });
        assert.equal(res.code, 0, res.stderr);
        assert.equal(res.stdout, `${JSON.stringify({ surface })}\n`);
        assert.equal(res.stderr, '');
      } finally {
        cleanup();
      }
    });
  }
});

test('surface exits 1, with the reason on stderr and nothing on stdout, for a script that is missing or does not parse', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    writeFiles(dir, { 'no-steps.md': '# Demo: No steps\n\n**Start:** `/`\n' });
    const cases = [
      ['missing.md', /demo script not found: .*missing\.md/],
      ['no-steps.md', /no steps found under "## Steps"/],
    ] as const;
    for (const [file, reason] of cases) {
      const res = await runCli(['surface', file], { cwd: dir });
      assert.equal(res.code, 1, `${file}: ${res.stdout}${res.stderr}`);
      assert.match(res.stderr, reason);
      assert.equal(res.stdout, '', file);
    }
  } finally {
    cleanup();
  }
});

test('surface refuses anything but one script path', async () => {
  for (const args of [[], ['a.md', 'b.md'], [SAMPLE, '--json']]) {
    const res = await runCli(['surface', ...args]);
    assert.equal(res.code, 1, args.join(' '));
    assert.match(res.stderr, /^surface: name one demo script, and no option/, args.join(' '));
    assert.equal(res.stdout, '', args.join(' '));
  }
});

test('provision refuses anything but appium or ffmpeg, and any option, before it installs', async () => {
  for (const args of [[], ['webdriveragent'], ['appium', 'ffmpeg'], ['appium', '--headed'], ['ffmpeg', '--headed']]) {
    const res = await runCli(['provision', ...args]);
    assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /^provision: name what to install \(appium, ffmpeg\), and no option/, args.join(' '));
    assert.doesNotMatch(res.stdout, /(appium|webdriveragent|ffmpeg): /, 'nothing was installed, built, fetched or looked up');
  }
});

test('provision ffmpeg finds the binary the engine uses in place, and fetches nothing', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const bin = stubFfmpeg(dir);
    const res = await runCli(['provision', 'ffmpeg'], { env: { ...process.env, FFMPEG_BIN: bin } });
    assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
    assert.equal(res.stdout, `ffmpeg: a binary is in place: ${bin}\n`);
  } finally {
    cleanup();
  }
});
