#!/usr/bin/env node
// The `sprintshow` command: run / screenshot / assemble / lint. Thin — it parses flags and
// calls the library, which is where the behaviour lives.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runDemo, runScreenshot, type CaptureMode } from './run.ts';
import { assembleVideo, type AssembleResult } from './assemble.ts';
import { lintCli } from './lint.ts';
import { outputSlug } from './demo-script.ts';
import { captureSimulator } from './simulator.ts';
import { compareGolden, updateGolden, DIFF_DIR } from './golden.ts';
import type { CaptureResult } from './capture.ts';
import type { ServeOptions } from './server.ts';

const HELP = `sprintshow — auto-generate a quick, unpolished demo video of what your app (or agent) just did.

Usage:
  sprintshow run <demo.md> [options]           Drive a demo script and produce an mp4
  sprintshow screenshot <demo.md> -o <file.png> [options]
                                               Drive a demo script and save the state its
                                               last step leaves as one PNG
  sprintshow simulator -o <dir> --device <type> [options]
                                               Run an iOS app's UI tests on a throwaway
                                               simulator, in light and in dark, and save
                                               the screenshots they attach
  sprintshow golden <run-dir> <golden-dir> [--update]
                                               Compare a run's screenshots with golden
                                               images, or rewrite the golden images
  sprintshow assemble <captures-dir> [options]  Frames + manifest.json → narrated mp4
  sprintshow lint <demo.md> [--strict]         Check a demo script before capturing

run options:
  --mode <walkthrough|proof>  walkthrough (default): one continuous recorded take.
                              proof: a screenshot per step, each proof-checked.
  --base-url <url>            Drive against a server already running.
  --serve "<command>"         Spawn a dev-server command, wait for it, then tear it down.
  --serve-dir <dir>           Serve a static directory with the built-in file server.
  --port <n>                  Port for --serve (default 5173) or --serve-dir (default: a
                              free port the system assigns).
  --cwd <dir>                 Working directory for --serve, and where a terminal
                              script's shell starts.
  -o, --output <file.mp4>     Output path (default demos/<script-name>.mp4).
  --music <file>              Mix a background-music bed under the narration.
  --no-narrate                Force a silent video even with OPENAI_API_KEY set.
  --keep                      Keep the .captures/<run>/ working dir.
  --headed                    Launch the browser headed (walkthrough).

screenshot options:
  --base-url, --serve, --serve-dir, --port, --cwd
                              Where the pages come from, as for run.
  -o, --output <file.png>     Output path (required).
  --full-page                 Capture the whole scrollable page instead of the viewport,
                              or a terminal script's whole session instead of its screen,
                              up to what Chromium draws in one capture: a page keeps its
                              top, and a session its last lines.
  --selector <css>            Capture one element, its first match, once it is visible.
  --scale <n>                 Device scale factor (default: the script's device's, or 1).
                              At 2, text stays sharp in a PNG shown at half its size.
  --transparent               Leave out the page's default white background.
  --each-step                 Save the state each step leaves instead, as
                              <NN>-<caption>.png in the new or empty directory -o names.
  Each step's proof is checked as proof mode checks it, with no caption drawn, and
  neither ffmpeg nor OPENAI_API_KEY is needed.

terminal scripts:
  A script that declares **Terminal:** drives a bash session in the engine's own
  terminal instead of a page, and takes no --base-url, --serve, --serve-dir or --port.
  Its shell starts in --cwd. Its steps run commands and press keys, and its proofs read
  the screen, a row, the cursor or the last command's exit status. screenshot saves
  the terminal window, its rounded corners transparent.

simulator options (macOS with Xcode and an iOS Simulator runtime):
  --project <x.xcodeproj>     The app's Xcode project, or
  --workspace <x.xcworkspace> its workspace, built for testing with --scheme.
  --scheme <name>             The scheme whose test action holds the UI tests.
  --xctestrun <file>          Or a build already made: the .xctestrun file that
                              \`xcodebuild build-for-testing\` wrote.
  --device <type>             The device type to create, as the host names it, such as
                              "iPhone 17 Pro" (required).
  --runtime <version>         The iOS version to run, such as 27.0 (default: the newest
                              the host has that runs the device).
  --test <id>                 Run only this test, as -only-testing names it, such as
                              AppUITests/ScreenTests/testHome. Repeatable.
  --grant <bundle-id>         Grant this app every permission simctl grants before the
                              tests run, so no permission prompt stops them. Repeatable.
  --video                     Record each pass's screen as <appearance>.mp4 in -o.
  --keep                      Keep the .captures/<run>/ working dir: the build, the result
                              bundles and xcodebuild's logs.
  -o, --output <dir>          A new or empty directory for the screenshots (required).
  The UI tests drive the app. Each pass, light and then dark, runs them on a device of
  its own, created for it with a fixed status bar and deleted after it. Each PNG a test
  attaches with XCTAttachment is saved as <name>.<appearance>.png.

golden options:
  --update                    Rewrite the golden images from the run: write its new and
                              changed images and remove the ones it no longer has.
  --threshold <0..1>          How far a pixel's colour may move before the pixel differs
                              (default 0.1).
  --max-diff-pixels <n>       How many pixels of an image may differ before the image
                              does (default 0).
  Each image that differs from its golden image gets a diff image in the run's
  golden-diff/ directory.

run, screenshot and simulator exit codes:
  0                           The output is saved and every step's proof held, or every
                              UI test passed.
  3                           The output is saved, but a step's proof or a UI test failed.
  1                           No output is saved.

golden exit codes:
  0                           Every image matches its golden image, or --update wrote them.
  3                           An image differs, or one side has an image the other lacks.
  1                           Nothing was compared.

assemble options:
  -o, --output <file.mp4>     Output path (default demos/<dir-name>.mp4).
  --music <file>              Mix a background-music bed under the narration.
  --no-narrate                Force a silent video.

Narration is optional: set OPENAI_API_KEY to voice the steps (tts-1/nova; override with
DEMO_TTS_MODEL / DEMO_TTS_VOICE). Without it the mp4 is silent and captioned.

An app behind Vercel's sign-in: set VERCEL_AUTOMATION_BYPASS_SECRET to the project's
Protection Bypass for Automation key. When the start path, or a URL it redirects to on the
base URL's origin or on its host over https, answers with Vercel's sign-in, the key is sent
once, to that URL alone, and the browser carries the cookie it earns. Without the key, such
a capture stops and says it reached the sign-in.`;

const BOOLEAN_FLAGS = new Set(['no-narrate', 'keep', 'headed', 'strict', 'full-page', 'transparent', 'each-step', 'video', 'update']);
/** Flags that may be given more than once, each time adding a value. */
const REPEATABLE_FLAGS = new Set(['test', 'grant']);

interface Parsed {
  pos: string[];
  flags: Record<string, string | boolean | string[]>;
}

function collect(args: string[]): Parsed {
  const flags: Parsed['flags'] = {};
  const pos: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-o') {
      flags.output = takeValue('-o', args[++i]);
    } else if (a.startsWith('--')) {
      const name = a.slice(2);
      if (BOOLEAN_FLAGS.has(name)) flags[name] = true;
      else if (REPEATABLE_FLAGS.has(name)) flags[name] = [...((flags[name] as string[] | undefined) ?? []), takeValue(a, args[++i])];
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

/** The server options from the flags `run` and `screenshot` share. The server checks the port. */
function serveOptions(flags: Parsed['flags']): ServeOptions {
  return {
    baseUrl: (flags['base-url'] as string) ?? null,
    serve: (flags.serve as string) ?? null,
    serveDir: (flags['serve-dir'] as string) ?? null,
    port: flags.port === undefined ? undefined : Number(flags.port),
    cwd: flags.cwd as string | undefined,
  };
}

/**
 * The exit code of a capture command that saved its output: 0 when every step's proof
 * held, 3 when one failed. A capture that saves nothing throws, and main() exits 1.
 */
function savedExit(failures: number): number {
  return failures > 0 ? 3 : 0;
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
    ...serveOptions(flags),
    outputPath: flags.output as string | undefined,
    musicPath: (flags.music as string) ?? null,
    noNarrate: Boolean(flags['no-narrate']),
    keep: Boolean(flags.keep),
    headed: Boolean(flags.headed),
  });
  reportRun(res);
  return savedExit(res.failures);
}

async function screenshotCommand(rest: string[]): Promise<number> {
  const { pos, flags } = collect(rest);
  const script = pos[0];
  const output = flags.output as string | undefined;
  const eachStep = Boolean(flags['each-step']);
  if (!script || !output) {
    console.error(`screenshot: ${script ? `an output path (-o <${eachStep ? 'dir' : 'file.png'}>)` : 'a demo-script path'} is required.\n`);
    console.log(HELP);
    return 1;
  }
  const res = await runScreenshot({
    script,
    outputPath: path.resolve(output),
    eachStep,
    ...serveOptions(flags),
    fullPage: Boolean(flags['full-page']),
    selector: (flags.selector as string) ?? null,
    scale: flags.scale === undefined ? undefined : Number(flags.scale),
    transparent: Boolean(flags.transparent),
  });
  console.log('');
  console.log(eachStep ? `✅ ${res.paths.length} screenshot(s), one for each step → ${path.relative(process.cwd(), res.outputPath)}` : `✅ screenshot → ${path.relative(process.cwd(), res.outputPath)}`);
  if (res.failures > 0) console.log(`   ⚠️  ${res.failures} step(s) failed their proof — the screenshot${eachStep ? 's show' : ' shows'} the state they left`);
  return savedExit(res.failures);
}

async function simulatorCommand(rest: string[]): Promise<number> {
  const { pos, flags } = collect(rest);
  const output = flags.output as string | undefined;
  const device = flags.device as string | undefined;
  if (pos.length > 0) throw new Error(`simulator: takes no demo script; the app's UI tests are its steps (got "${pos[0]}")`);
  if (!output || !device) {
    console.error(`simulator: ${output ? 'a device type (--device "iPhone 17 Pro")' : 'an output directory (-o <dir>)'} is required.\n`);
    console.log(HELP);
    return 1;
  }
  const res = await captureSimulator({
    project: flags.project as string | undefined,
    workspace: flags.workspace as string | undefined,
    scheme: flags.scheme as string | undefined,
    xctestrun: flags.xctestrun as string | undefined,
    device,
    runtime: flags.runtime as string | undefined,
    tests: (flags.test as string[] | undefined) ?? [],
    grant: (flags.grant as string[] | undefined) ?? [],
    video: Boolean(flags.video),
    outputDir: output,
    keep: Boolean(flags.keep),
  });
  const videos = res.passes.flatMap((p) => (p.video ? [path.basename(p.video)] : []));
  console.log('');
  console.log(`✅ ${res.screenshots.length} screenshot(s)${videos.length ? ` and ${videos.join(', ')}` : ''} of ${res.device} on ${res.runtime} → ${path.relative(process.cwd(), path.resolve(output)) || '.'}`);
  if (res.failures > 0) console.log(`   ⚠️  ${res.failures} UI test(s) failed — the screenshots they attached are saved`);
  return savedExit(res.failures);
}

async function goldenCommand(rest: string[]): Promise<number> {
  const { pos, flags } = collect(rest);
  const [runDir, goldenDir] = pos;
  if (!runDir || !goldenDir) {
    console.error('golden: a run\'s directory and the golden images\' directory are required.\n');
    console.log(HELP);
    return 1;
  }
  const opts = {
    runDir: path.resolve(runDir),
    goldenDir: path.resolve(goldenDir),
    threshold: flags.threshold === undefined ? undefined : Number(flags.threshold),
    maxDiffPixels: flags['max-diff-pixels'] === undefined ? undefined : Number(flags['max-diff-pixels']),
  };
  if (flags.update) {
    const res = updateGolden(opts);
    console.log('');
    console.log(`✅ golden images updated → ${path.relative(process.cwd(), opts.goldenDir) || '.'} (${res.written.length} written, ${res.removed.length} removed)`);
    return 0;
  }
  const res = compareGolden(opts);
  console.log('');
  if (res.differences === 0) {
    console.log(`✅ every image matches its golden image in ${path.relative(process.cwd(), opts.goldenDir) || '.'}`);
    return 0;
  }
  // An image only one side has gets no diff image, so a run can differ with none written.
  const diffs = res.images.some((i) => i.diffPath) ? ` — the diff images are in ${path.relative(process.cwd(), path.join(opts.runDir, DIFF_DIR))}` : '';
  console.log(`❌ ${res.differences} image(s) differ from the golden images${diffs}`);
  return 3;
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
    case 'screenshot':
      return screenshotCommand(rest);
    case 'simulator':
      return simulatorCommand(rest);
    case 'golden':
      return goldenCommand(rest);
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
