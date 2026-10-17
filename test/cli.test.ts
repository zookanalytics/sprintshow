// Tests for what the two capture commands share in the CLI (src/cli.ts): `run` and
// `screenshot` read their server flags through one mapping, and both exit 0 when the
// output is saved and every step's proof held, 3 when it is saved but a proof failed, and
// 1 when nothing is saved.
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
