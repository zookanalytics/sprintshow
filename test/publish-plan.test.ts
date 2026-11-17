// Tests for what a run of the publish workflow decides (.github/scripts/publish-plan.sh):
// whether it publishes package.json's version, whether it creates the version's GitHub
// release, the tag that release's notes start from, and whether the release is marked
// Latest.
//
// Each case runs the script in a git repository of its own, checked out at one commit, as
// the workflow's checkout is. The history is 0.1.0 tagged v0.1.0, a commit that sets
// 0.2.0, and a later commit that leaves it, then, where a case asks for a newer release,
// a commit that sets 0.3.0 tagged v0.3.0. Stand-ins for npm and gh answer as npm 12 and gh
// answer, so no case reaches the network. `npm view <spec> version gitHead --json` prints
// an array holding the version and its gitHead for a version npm has, and for one it lacks
// prints {"error":{"code":"E404",...}} and exits 1. `gh release view <tag>` exits 0 for a
// release that exists and 1 for one that does not. Any other call fails the stand-in.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PLAN = path.join(import.meta.dirname, '..', '.github', 'scripts', 'publish-plan.sh');
const NAME = '@zookanalytics/sprintshow';

const scratch = mkdtempSync(path.join(tmpdir(), 'sprintshow-publish-plan-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const BIN = path.join(scratch, 'bin');
mkdirSync(BIN);
writeFileSync(
  path.join(BIN, 'npm'),
  `#!/bin/sh
[ "$*" = "$NPM_ARGS" ] || { echo "unexpected call: npm $*" >&2; exit 2; }
printf '%s\\n' "$NPM_STDOUT"
exit "$NPM_EXIT"
`,
  { mode: 0o755 },
);
writeFileSync(
  path.join(BIN, 'gh'),
  `#!/bin/sh
[ "$1 $2" = "release view" ] && [ $# -eq 3 ] || { echo "unexpected call: gh $*" >&2; exit 2; }
for tag in $RELEASES; do [ "$tag" = "$3" ] && exit 0; done
echo "release not found" >&2
exit 1
`,
  { mode: 0o755 },
);

// Git's own variables are dropped, so a hook's GIT_DIR cannot point these commands at
// the repository that runs the suite, and no user or system config applies.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'sprintshow test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'sprintshow test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

interface History {
  repo: string;
  /** The commit that sets 0.2.0. */
  released: string;
  /** A later commit that leaves the version at 0.2.0. */
  later: string;
}

function history({ newerRelease }: { newerRelease: boolean }): History {
  const repo = mkdtempSync(path.join(scratch, 'repo-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  const commit = (version: string): string => {
    writeFileSync(path.join(repo, 'package.json'), `${JSON.stringify({ name: NAME, version })}\n`);
    git('add', 'package.json');
    git('commit', '--quiet', '--allow-empty', '--message', version);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet', '--initial-branch', 'main');
  commit('0.1.0');
  git('tag', 'v0.1.0');
  const released = commit('0.2.0');
  const later = commit('0.2.0');
  if (newerRelease) {
    commit('0.3.0');
    git('tag', 'v0.3.0');
  }
  return { repo, released, later };
}

interface Answers {
  /** What npm's view of 0.2.0 prints, and its exit code. */
  npm: { stdout: string; exit: number };
  /** The tags GitHub has a release for. */
  releases: string[];
}

const npmLacks = { stdout: JSON.stringify({ error: { code: 'E404', summary: 'No match found for version 0.2.0' } }), exit: 1 };
const npmHasFrom = (gitHead: string) => ({ stdout: JSON.stringify([{ version: '0.2.0', gitHead }]), exit: 0 });

/** Run the plan in `h`'s repository checked out at `at`, with GITHUB_SHA set to it. */
function plan(h: History, at: string, answers: Answers): { status: number | null; outputs: Record<string, string>; log: string } {
  execFileSync('git', ['checkout', '--quiet', '--detach', at], { cwd: h.repo, env: GIT_ENV });
  const runnerTemp = mkdtempSync(path.join(scratch, 'runner-'));
  const outputFile = path.join(runnerTemp, 'output');
  writeFileSync(outputFile, '');
  const res = spawnSync(PLAN, {
    cwd: h.repo,
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
      GITHUB_SHA: at,
      GITHUB_OUTPUT: outputFile,
      RUNNER_TEMP: runnerTemp,
      NPM_ARGS: `view ${NAME}@0.2.0 version gitHead --json`,
      NPM_STDOUT: answers.npm.stdout,
      NPM_EXIT: String(answers.npm.exit),
      RELEASES: answers.releases.join(' '),
    },
  });
  const outputs = Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  );
  return { status: res.status, outputs, log: `${res.stdout}${res.stderr}` };
}

test('a version npm lacks is published, then released with notes from the release before it', () => {
  const h = history({ newerRelease: false });
  const run = plan(h, h.released, { npm: npmLacks, releases: ['v0.1.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'true', release: 'true', previous: 'v0.1.0', latest: 'true' });
});

test('a re-run of the run that published creates only the missing release', () => {
  const h = history({ newerRelease: false });
  const run = plan(h, h.released, { npm: npmHasFrom(h.released), releases: ['v0.1.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'false', release: 'true', previous: 'v0.1.0', latest: 'true' });
});

test('a re-run made after a newer release takes its notes from the release before its own commit, and leaves the newer release Latest', () => {
  const h = history({ newerRelease: true });
  const run = plan(h, h.released, { npm: npmHasFrom(h.released), releases: ['v0.1.0', 'v0.3.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'false', release: 'true', previous: 'v0.1.0', latest: 'false' });
});

test("a release on a commit that already has its version's tag is still marked Latest", () => {
  const h = history({ newerRelease: false });
  execFileSync('git', ['tag', 'v0.2.0', h.released], { cwd: h.repo, env: GIT_ENV });
  const run = plan(h, h.released, { npm: npmHasFrom(h.released), releases: ['v0.1.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'false', release: 'true', previous: 'v0.1.0', latest: 'true' });
});

test('a version whose release exists is neither published nor released again', () => {
  const h = history({ newerRelease: false });
  const run = plan(h, h.released, { npm: npmHasFrom(h.released), releases: ['v0.1.0', 'v0.2.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'false', release: 'false', previous: '', latest: '' });
});

test('a later push that leaves the version unchanged tags nothing, even while its release is missing', () => {
  const h = history({ newerRelease: false });
  const run = plan(h, h.later, { npm: npmHasFrom(h.released), releases: ['v0.1.0'] });
  assert.equal(run.status, 0, run.log);
  assert.deepEqual(run.outputs, { version: '0.2.0', publish: 'false', release: 'false', previous: '', latest: '' });
});

test('a registry error other than E404 fails the run before it decides anything', () => {
  const h = history({ newerRelease: false });
  const npmFails = { stdout: JSON.stringify({ error: { code: 'E500', summary: 'Internal Server Error' } }), exit: 1 };
  const run = plan(h, h.released, { npm: npmFails, releases: ['v0.1.0'] });
  assert.notEqual(run.status, 0);
  assert.deepEqual(run.outputs, {});
  assert.match(run.log, /E500/);
});
