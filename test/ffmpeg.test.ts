// Tests for provisionFfmpeg (src/ffmpeg.ts) in a project laid out as npm lays out one that
// installed sprintshow: ffmpeg-static is hoisted into the project's own node_modules,
// beside sprintshow and not inside it, and the provision runs from a subdirectory of the
// project, which has no node_modules of its own. The module under test is a copy of
// src/ffmpeg.ts put in that project, which works because it imports none of the engine's
// own modules. The project's ffmpeg-static is the real package's index.js and
// package.json, so the binary's place is the one the real package resolves. Its install
// script is a stand-in, which records each run and writes a stand-in binary at that place
// instead of downloading one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = path.join(import.meta.dirname, '..');
const FFMPEG_STATIC = path.dirname(createRequire(import.meta.url).resolve('ffmpeg-static/package.json'));

type FfmpegModule = typeof import('../src/ffmpeg.ts');

/**
 * The fetch the engine names, by the package's published name, which npx takes. npx runs
 * the package of that name where one is installed, and fetches it by that name where none
 * is, as for a user who runs sprintshow through npx with no install.
 */
const FETCH = `npx ${JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8')).name} provision ffmpeg`;

/** Whether `err` is the engine's diagnosis of a missing binary, naming FETCH. */
function noBinary(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('no ffmpeg binary available. ') &&
    err.message.endsWith(` fetch it once with \`${FETCH}\`, or with \`npm run provision:ffmpeg\` in a checkout of sprintshow, or set FFMPEG_BIN to a system ffmpeg.`)
  );
}

/**
 * Run `body` with the ffmpeg module of a project that installed sprintshow, from the
 * project's `app` directory and with no FFMPEG_BIN. The project's stand-in install script
 * records each run, then writes the binary, or, given `fail`, exits 1 and writes none.
 * Resolves with the recorded runs.
 */
async function inInstalledProject(fail: boolean, body: (ffmpeg: FfmpegModule, project: string) => Promise<void>): Promise<string[]> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'sprintshow-ffmpeg-')));
  const project = path.join(dir, 'project');
  const ffmpegStatic = path.join(project, 'node_modules', 'ffmpeg-static');
  const sprintshow = path.join(project, 'sprintshow');
  const runs = path.join(dir, 'install-runs');
  mkdirSync(ffmpegStatic, { recursive: true });
  for (const file of ['package.json', 'index.js']) copyFileSync(path.join(FFMPEG_STATIC, file), path.join(ffmpegStatic, file));
  writeFileSync(
    path.join(ffmpegStatic, 'install.js'),
    "'use strict';\nconst fs = require('fs');\n" +
      `fs.appendFileSync(${JSON.stringify(runs)}, 'ran\\n');\n` +
      (fail ? 'process.exit(1);\n' : "fs.writeFileSync(require('.'), '#!/bin/sh\\n', { mode: 0o755 });\n"),
  );
  mkdirSync(path.join(sprintshow, 'src'), { recursive: true });
  writeFileSync(path.join(sprintshow, 'package.json'), '{ "type": "module" }\n');
  copyFileSync(path.join(REPO, 'src', 'ffmpeg.ts'), path.join(sprintshow, 'src', 'ffmpeg.ts'));
  mkdirSync(path.join(project, 'app'));
  const saved = { cwd: process.cwd(), FFMPEG_BIN: process.env.FFMPEG_BIN };
  delete process.env.FFMPEG_BIN;
  process.chdir(path.join(project, 'app'));
  try {
    const ffmpeg: FfmpegModule = await import(pathToFileURL(path.join(sprintshow, 'src', 'ffmpeg.ts')).href);
    await body(ffmpeg, project);
    return existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n') : [];
  } finally {
    process.chdir(saved.cwd);
    if (saved.FFMPEG_BIN !== undefined) process.env.FFMPEG_BIN = saved.FFMPEG_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("provision fetches the binary with ffmpeg-static's own install script, found where npm hoists it in a project that installed sprintshow, once", async () => {
  const runs = await inInstalledProject(false, async (ffmpeg, project) => {
    const bin = path.join(project, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    assert.throws(() => ffmpeg.requireFfmpeg(), noBinary);
    const logs: string[] = [];
    assert.equal(await ffmpeg.provisionFfmpeg((m) => logs.push(m)), bin);
    assert.equal(ffmpeg.requireFfmpeg(), bin);
    assert.equal(await ffmpeg.provisionFfmpeg((m) => logs.push(m)), bin);
    assert.deepEqual(logs, ["ffmpeg: fetching ffmpeg-static's binary…", `ffmpeg: fetched ${bin}`, `ffmpeg: a binary is in place: ${bin}`]);
  });
  assert.deepEqual(runs, ['ran'], 'the install script ran once');
});

test('a fetch the install script fails leaves no binary, and the engine still names the command that fetches it', async () => {
  const runs = await inInstalledProject(true, async (ffmpeg) => {
    await assert.rejects(ffmpeg.provisionFfmpeg(() => {}), /^Error: ffmpeg: ffmpeg-static's install script exited 1$/);
    assert.throws(() => ffmpeg.requireFfmpeg(), noBinary);
  });
  assert.deepEqual(runs, ['ran']);
});
