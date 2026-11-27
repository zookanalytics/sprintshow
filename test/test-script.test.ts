// Tests for package.json's test script. A test that never settles fails once it runs past
// the script's --test-timeout, and a test file ends when its tests do, even when a test
// leaves a child process running, as a test that leaks a browser or a shell does.
// --test-force-exit ends the file but not the child, so this test kills the children its
// fixtures start.
//
// Node 22 holds each test file to the limit, so a test's own longer `timeout` does not
// lift it there. Node 24 and 26 hold each test and each hook to it, and count no time a
// test spends blocked in a synchronous call such as execFileSync. So the limit has to
// clear the slowest test file on a busy host, not only the slowest test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { scratchDir, writeFiles, REPO } from './browser-fixture.ts';

/**
 * The limit the fixtures run under: short, so the test is quick, and long enough for each
 * fixture file to start its child on a busy host, since Node 22 counts a file's start
 * against the limit.
 */
const LIMIT_MS = 5000;

/** The words of package.json's test script between `node` and its quoted file pattern. */
function testScriptFlags(): string[] {
  const script: string = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).scripts.test;
  const [command, ...words] = script.split(/\s+/);
  assert.equal(command, 'node', `the test script runs node: ${script}`);
  return words.filter((w) => !w.startsWith('"'));
}

/**
 * A test file whose one test starts a child process that idles, writes the child's pid to
 * `pidFile`, and then passes, or waits on a promise that never settles.
 */
function leavesChild(pidFile: string, ends: 'passes' | 'never settles'): string {
  return [
    "import { test } from 'node:test';",
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    `test(${JSON.stringify(`${ends}, and leaves a child process running`)}, () => {`,
    "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
    ends === 'passes' ? '' : '  return new Promise(() => {});',
    '});',
    '',
  ].join('\n');
}

interface NodeRun {
  ended: boolean;
  code: number | null;
  output: string;
}

/** Run `node <args>` in `cwd`, and kill it if it is still running after `ms`. */
function runNode(args: string[], cwd: string, ms: number): Promise<NodeRun> {
  // The test runner sets NODE_TEST_CONTEXT for this file, and a `node --test` that
  // inherits it runs no file.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    let ended = true;
    const timer = setTimeout(() => {
      ended = false;
      child.kill('SIGKILL');
    }, ms);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ended, code, output });
    });
  });
}

test('the test script fails a test that never settles at its --test-timeout, and ends the run though its tests left child processes running', async (t) => {
  const flags = testScriptFlags();
  const limit = flags.findIndex((f) => /^--test-timeout=\d+$/.test(f));
  assert.notEqual(limit, -1, `the test script sets a --test-timeout: ${flags.join(' ')}`);

  const { dir, cleanup } = scratchDir();
  const pidFiles = [path.join(dir, 'never-settles.pid'), path.join(dir, 'passes.pid')];
  t.after(() => {
    for (const file of pidFiles) {
      if (!existsSync(file)) continue;
      try {
        process.kill(Number(readFileSync(file, 'utf8')));
      } catch {
        // The child has already exited.
      }
    }
    cleanup();
  });
  writeFiles(dir, {
    'never-settles.test.mjs': leavesChild(pidFiles[0], 'never settles'),
    'passes.test.mjs': leavesChild(pidFiles[1], 'passes'),
  });

  const args = flags.map((f, i) => (i === limit ? `--test-timeout=${LIMIT_MS}` : f));
  const run = await runNode([...args, 'never-settles.test.mjs', 'passes.test.mjs'], dir, 60_000);

  assert.ok(run.ended, `the run ended within 60 s:\n${run.output}`);
  assert.equal(run.code, 1, `the run failed:\n${run.output}`);
  assert.match(run.output, new RegExp(`test timed out after ${LIMIT_MS}ms`), 'the test that never settles failed at the limit');
  assert.match(run.output, /^(# |ℹ )pass 1$/m, 'the test that passed counts as a pass');
  assert.match(run.output, /^(# |ℹ )cancelled 1$/m, 'the run cut off only the test that never settles, not the file whose test passed');
  for (const file of pidFiles) assert.ok(existsSync(file), `each test started its child: ${file}`);
});
