#!/usr/bin/env node
// The `sprintshow` command: run / assemble / lint. Thin — it parses flags and calls the
// library, which is where the behaviour lives.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runDemo, type CaptureMode } from './run.ts';
import { assembleVideo, type AssembleResult } from './assemble.ts';
import { lintCli } from './lint.ts';
import { outputSlug } from './demo-script.ts';
import type { CaptureResult } from './capture.ts';

const HELP = `sprintshow — auto-generate a quick, unpolished demo video of what your app (or agent) just did.

Usage:
  sprintshow run <demo.md> [options]           Drive a demo script and produce an mp4
  sprintshow assemble <captures-dir> [options]  Frames + manifest.json → narrated mp4
  sprintshow lint <demo.md> [--strict]         Check a demo script before capturing

run options:
  --mode <walkthrough|proof>  walkthrough (default): one continuous recorded take.
                              proof: a screenshot per step, each proof-checked.
  --base-url <url>            Drive against a server already running.
  --serve "<command>"         Spawn a dev-server command, wait for it, then tear it down.
  --serve-dir <dir>           Serve a static directory with the built-in file server.
  --port <n>                  Port for --serve / --serve-dir (default 5173).
  --cwd <dir>                 Working directory for --serve.
  -o, --output <file.mp4>     Output path (default demos/<script-name>.mp4).
  --music <file>              Mix a background-music bed under the narration.
  --no-narrate                Force a silent video even with OPENAI_API_KEY set.
  --keep                      Keep the .captures/<run>/ working dir.
  --headed                    Launch the browser headed (walkthrough).

assemble options:
  -o, --output <file.mp4>     Output path (default demos/<dir-name>.mp4).
  --music <file>              Mix a background-music bed under the narration.
  --no-narrate                Force a silent video.

Narration is optional: set OPENAI_API_KEY to voice the steps (tts-1/nova; override with
DEMO_TTS_MODEL / DEMO_TTS_VOICE). Without it the mp4 is silent and captioned.`;

const BOOLEAN_FLAGS = new Set(['no-narrate', 'keep', 'headed', 'strict']);

interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean>;
}

function collect(args: string[]): Parsed {
  const flags: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') {
      flags.output = takeValue('-o', args[++i]);
    } else if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else flags[name] = takeValue(a, args[++i]);
    } else if (a.startsWith('-') && a !== '-') {
      throw new Error(`unknown flag: ${a}`);
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function takeValue(flag: string, v: string | undefined): string {
  if (v === undefined) throw new Error(`${flag} needs a value`);
  return v;
}

function reportRun(res: CaptureResult): void {
  const kind = res.narrated ? 'narrated' : 'silent';
  const music = res.music ? ' + music bed' : '';
  console.log('');
  console.log(`✅ ${kind}${music} demo → ${path.relative(process.cwd(), res.outputPath)}`);
  if (res.failures > 0) {
    console.log(`   ⚠️  ${res.failures} step(s) failed their proof — video and frames kept${res.capturesDir ? `: ${path.relative(process.cwd(), res.capturesDir)}` : ''}`);
  } else if (res.capturesDir) {
    console.log(`   working dir kept: ${path.relative(process.cwd(), res.capturesDir)}`);
  }
}

async function runCommand(rest: string[]): Promise<number> {
  const { pos, flags } = collect(rest);
  const script = pos[0];
  if (!script) {
    console.error('run: a demo-script path is required.\n');
    console.log(HELP);
    return 1;
  }
  const mode = flags.mode as CaptureMode | undefined;
  if (mode && mode !== 'proof' && mode !== 'walkthrough') {
    console.error(`run: --mode must be "walkthrough" or "proof" (got "${mode}")`);
    return 1;
  }
  const res = await runDemo({
    script,
    mode,
    baseUrl: (flags['base-url'] as string) ?? null,
    serve: (flags.serve as string) ?? null,
    serveDir: (flags['serve-dir'] as string) ?? null,
    port: flags.port ? Number(flags.port) : undefined,
    cwd: flags.cwd as string | undefined,
    outputPath: flags.output as string | undefined,
    musicPath: (flags.music as string) ?? null,
    noNarrate: Boolean(flags['no-narrate']),
    keep: Boolean(flags.keep),
    headed: Boolean(flags.headed),
  });
  reportRun(res);
  return res.failures > 0 ? 1 : 0;
}

async function assembleCommand(rest: string[]): Promise<number> {
  const { pos, flags } = collect(rest);
  const dir = pos[0];
  if (!dir) {
    console.error('assemble: a captures directory is required.\n');
    console.log(HELP);
    return 1;
  }
  // Default output name drops the run's `-<timestamp>` suffix from the dir basename.
  const slug = outputSlug(path.basename(path.resolve(dir)).replace(/-\d{6,}$/, ''));
  const outputPath = (flags.output as string) ?? path.join(process.cwd(), 'demos', `${slug}.mp4`);
  const res: AssembleResult = await assembleVideo({
    capturesDir: path.resolve(dir),
    outputPath,
    noNarrate: Boolean(flags['no-narrate']),
    musicPath: (flags.music as string) ?? null,
  });
  console.log('');
  console.log(`✅ ${res.narrated ? 'narrated' : 'silent'}${res.music ? ' + music bed' : ''} demo → ${path.relative(process.cwd(), res.outputPath)}`);
  return 0;
}

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    console.log(HELP);
    return 0;
  }
  if (cmd === '--version' || cmd === '-v') {
    console.log(version());
    return 0;
  }
  switch (cmd) {
    case 'run':
      return runCommand(rest);
    case 'assemble':
      return assembleCommand(rest);
    case 'lint': {
      const { pos, flags } = collect(rest);
      return lintCli(pos[0], Boolean(flags.strict));
    }
    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    console.error(`\n✖ ${(e as Error).message}`);
    process.exitCode = 1;
  });
