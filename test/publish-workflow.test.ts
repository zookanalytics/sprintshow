// Tests for the layout of the publish workflow (.github/workflows/publish.yml). The job
// that runs the installed-package check (.github/actions/installed-package) installs the
// package's dependencies afresh from the registry and runs them, so it holds no write
// permission of its own or from the workflow, and the job that publishes waits for it.
//
// The workflow is read as text, with no YAML parser. A key's value is the rest of its line
// and the lines indented beneath it, with comments dropped. A job is a key indented two
// spaces beneath `jobs:`, and its own keys are indented four.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKFLOW = path.join(import.meta.dirname, '..', '.github', 'workflows', 'publish.yml');

interface Entry {
  /** The value's text: the rest of the key's line, then the lines beneath it. */
  value: string;
  /** The lines beneath the key. */
  body: string[];
}

/** The keys at `depth` spaces among `lines`, each with its value. */
function keys(lines: string[], depth: number): Map<string, Entry> {
  const found = new Map<string, Entry>();
  let current: Entry | undefined;
  for (const line of lines) {
    const at = line.search(/\S/);
    const key = at === depth ? /^\s*([\w-]+):(.*)$/.exec(line) : null;
    if (key) {
      current = { value: key[2].trim(), body: [] };
      found.set(key[1], current);
    } else if (at > depth && current) {
      current.body.push(line);
      current.value += `\n${line.trim()}`;
    } else {
      current = undefined;
    }
  }
  return found;
}

const lines = readFileSync(WORKFLOW, 'utf8')
  .split('\n')
  .map((line) => line.replace(/(^|\s)#.*$/, '').trimEnd())
  .filter((line) => line !== '');
const workflow = keys(lines, 0);
const jobs = keys(workflow.get('jobs')?.body ?? [], 2);

/** The ids of the jobs with a line that matches `pattern`. */
function jobsWith(pattern: RegExp): string[] {
  return [...jobs].filter(([, job]) => job.body.some((line) => pattern.test(line))).map(([id]) => id);
}

const checkJobs = jobsWith(/^\s*(- )?uses:\s*\.\/\.github\/actions\/installed-package$/);
const publishJobs = jobsWith(/^\s*(- )?run:\s*npm publish\b/);

test('the job that runs the installed-package check holds no write permission', () => {
  assert.notDeepEqual(checkJobs, [], 'no job runs the installed-package check');
  for (const id of checkJobs) {
    // A job with no permissions of its own takes the workflow's, and with neither takes the
    // repository's default, which can write.
    const permissions = keys(jobs.get(id)!.body, 4).get('permissions') ?? workflow.get('permissions');
    assert.ok(permissions, `${id} takes the repository's default permissions`);
    assert.doesNotMatch(permissions.value, /write/, `${id} holds: ${permissions.value}`);
  }
});

test('the job that publishes waits for the installed-package check', () => {
  assert.notDeepEqual(publishJobs, [], 'no job runs npm publish');
  for (const id of publishJobs) {
    const needs: string[] = keys(jobs.get(id)!.body, 4).get('needs')?.value.match(/[\w-]+/g) ?? [];
    for (const check of checkJobs) {
      assert.ok(needs.includes(check), `${id} needs ${needs.join(', ') || 'no job'}, not ${check}`);
    }
  }
});
