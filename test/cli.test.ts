// Tests for what the two capture commands share in the CLI (src/cli.ts): `run` and
// `screenshot` read their server flags through one mapping.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { runCli, scratchDir, REPO } from './browser-fixture.ts';

const SAMPLE = path.join(REPO, 'demos', 'sample.md');
const SAMPLE_APP = path.join(REPO, 'examples', 'sample-app');

test('run and screenshot both refuse a --port that is not a whole number, before anything is served', async () => {
  const { dir, cleanup } = scratchDir();
  try {
    const common = [SAMPLE, '--serve-dir', SAMPLE_APP, '--port', 'abc'];
    const [run, shot] = await Promise.all([
      runCli(['run', ...common, '-o', path.join(dir, 'out.mp4')], { cwd: dir }),
      runCli(['screenshot', ...common, '-o', path.join(dir, 'out.png')], { cwd: dir }),
    ]);
    for (const res of [run, shot]) {
      assert.equal(res.code, 1, `${res.stdout}${res.stderr}`);
      assert.match(res.stderr, /server: the port must be a whole number from 1 to 65535 \(got NaN\)/);
      assert.doesNotMatch(res.stdout, /server: serving/);
    }
    assert.equal(existsSync(path.join(dir, 'out.png')), false);
    assert.equal(existsSync(path.join(dir, 'out.mp4')), false);
  } finally {
    cleanup();
  }
});
