// Shared fixtures for the browser-backed tests: a headless Chromium, a scratch site
// served by the engine's own static server, and a way to run the CLI as a user does.
//
// The browser is a provisioned asset (`npm run provision:browser`). On a host without
// it the browser-backed tests skip and name that command. Any other launch failure
// fails them, so a broken browser never passes as a missing one.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';

import { chromiumLaunchArgs } from '../src/browser.ts';
import { ensureServer } from '../src/server.ts';

export const REPO = path.join(import.meta.dirname, '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

/** A headless Chromium, or the reason the tests that need one skip. */
export async function launchBrowser(): Promise<{ browser: Browser | null; skip: string | false }> {
  try {
    return { browser: await chromium.launch({ headless: true, args: chromiumLaunchArgs() }), skip: false };
  } catch (e) {
    const msg = (e as Error).message;
    if (!/Executable doesn't exist/.test(msg)) throw e;
    return { browser: null, skip: 'no headless Chromium provisioned — `npm run provision:browser`' };
  }
}

/** A scratch directory, removed by `cleanup`. */
export function scratchDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Write each `files` entry (relative path to contents) under `dir`. */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
}

export interface Site {
  dir: string;
  baseUrl: string;
  close(): Promise<void>;
}

/** Serve `files` from a scratch directory. `close` stops the server and removes the directory. */
export async function serveSite(files: Record<string, string>): Promise<Site> {
  const { dir, cleanup } = scratchDir();
  writeFiles(dir, files);
  const server = await ensureServer({ serveDir: dir, log: () => {} });
  return {
    dir,
    baseUrl: server.baseUrl,
    close: async () => {
      await server.stop();
      cleanup();
    },
  };
}

/**
 * A stand-in ffmpeg that writes an empty file at its last argument. With narration off
 * and no music bed, every ffmpeg call the still-frame assembly makes names its output
 * last, so proof mode runs to completion on a host with no ffmpeg.
 */
export function stubFfmpeg(dir: string): string {
  const p = path.join(dir, 'ffmpeg-stub.mjs');
  writeFileSync(p, `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.argv[process.argv.length - 1], '');\n`, { mode: 0o755 });
  return p;
}

export interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run `sprintshow <args>` from the source tree, the way `node src/cli.ts` runs it. */
export function runCli(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<CliRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd ?? REPO, env: opts.env ?? process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** The lines a capture prints for its steps: each step's header and its result. */
export function stepLines(output: string): string[] {
  return output.split('\n').filter((l) => /^step \d+\/\d+: /.test(l) || /^ {2}[✓✗] /.test(l));
}
