// The simulator capture: an iOS app's own UI tests drive it on a throwaway iOS Simulator
// device, once in light and once in dark, and each screenshot the tests attach is saved
// under the name it is attached with.
//
// Everything it runs comes with Xcode. `xcodebuild build-for-testing` builds the app and
// its UI tests, unless the caller hands over a build already made, as the .xctestrun file
// that command writes. For each appearance, `xcrun simctl` creates a device of the named
// type on an iOS runtime the host has, boots it, fixes its status bar and sets its
// appearance. `xcodebuild test-without-building` then installs the app and its test
// runner on that device and runs the tests, and `xcrun xcresulttool export attachments`
// takes the screenshots out of the result bundle. The device is deleted once its pass
// ends, however the pass ends, so two runs never share a device, and a pass starts from a
// device no earlier pass has touched.
//
// The UI tests are the steps. A UI test drives the app as a person does, with taps,
// typing, and waits on what the screen shows, and attaches a screenshot where a step ends:
//
//   let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
//   attachment.name = "01-board"
//   attachment.lifetime = .keepAlways
//   add(attachment)
//
// Each PNG the tests attach is saved as `<name>.<appearance>.png`, so the screenshots of
// one step in light and in dark sort together. A test that fails still has the
// screenshots it attached saved, and the result counts the failure.
//
// specs/ss-pqt8i/design.md records why the UI tests drive the app.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { constants, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

import { deviceName, nearestNames } from './demo-script.ts';
import { claimOutputDir } from './golden.ts';

/** The appearances a capture runs in, in order. */
export type Appearance = 'light' | 'dark';
export const APPEARANCES: readonly Appearance[] = ['light', 'dark'];

/**
 * The status bar of every pass: 9:41, full Wi-Fi and cellular bars and a charged battery,
 * so a screenshot does not change with the time of day, the network or the battery.
 */
export const STATUS_BAR = ['--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100'];

/** How long a video recording is given to start before the pass goes on without it. */
const RECORDING_START_MS = 30000;
/** How many of a log's lines an error quotes. */
const QUOTED_LINES = 12;

export interface CaptureSimulatorOptions {
  /** The app's Xcode project, built for testing with `scheme`. */
  project?: string;
  /** Or its workspace, built for testing with `scheme`. */
  workspace?: string;
  /** The scheme whose test action holds the UI tests. Needed with `project` or `workspace`. */
  scheme?: string;
  /** Or a build already made: the .xctestrun file `xcodebuild build-for-testing` wrote. */
  xctestrun?: string;
  /** The device type to create, as the host names it, such as `iPhone 17 Pro`. Case and the spaces between words do not matter. */
  device: string;
  /** The iOS version to run, such as `27.0` or `27`. Default: the newest the host has that runs the device. */
  runtime?: string;
  /** Run only these tests, each an `-only-testing` identifier such as `AppUITests/ScreenTests/testHome`. Default: every test the scheme's test action holds. */
  tests?: string[];
  /** Grant the app of each of these bundle identifiers every permission simctl grants, before the tests run, so no permission prompt stops them. */
  grant?: string[];
  /** Record each pass's screen, as `<appearance>.mp4` in `outputDir`. */
  video?: boolean;
  /** Where the screenshots go: a new or empty directory. */
  outputDir: string;
  /** Keep the `.captures/<run>/` working dir: the build, the result bundles and xcodebuild's logs. A run that saves no screenshot keeps it anyway. */
  keep?: boolean;
  /** Where the `.captures/<run>/` working dir is created (default: the working directory). */
  captureRoot?: string;
  log?: (m: string) => void;
}

export interface SimulatorScreenshot {
  /** The name it was attached with, made safe for a file name. */
  name: string;
  appearance: Appearance;
  /** The PNG, `<outputDir>/<name>.<appearance>.png`. */
  path: string;
  /** The test that attached it. */
  test: string;
}

export interface SimulatorPass {
  appearance: Appearance;
  /** Every test that ran passed. */
  passed: boolean;
  /** How many tests failed. */
  failedTests: number;
  /** Why they failed: each failure the results give, with its test. */
  failures: string[];
  screenshots: SimulatorScreenshot[];
  /** The pass's video, when one was asked for and recorded. */
  video?: string;
}

export interface SimulatorResult {
  /** The device type and the runtime the passes ran on, as the host names them. */
  device: string;
  runtime: string;
  passes: SimulatorPass[];
  /** Every pass's screenshots. */
  screenshots: SimulatorScreenshot[];
  /** How many tests failed, over every pass. */
  failures: number;
  /** The working dir, if it was kept; otherwise null. */
  capturesDir: string | null;
}

/** An iOS runtime, as `xcrun simctl list runtimes -j` describes it. */
export interface SimRuntime {
  identifier: string;
  name: string;
  version: string;
  isAvailable?: boolean;
  platform?: string;
  supportedDeviceTypes?: { identifier: string; name: string }[];
}

/** What the attachments manifest says of one test: `xcrun xcresulttool export attachments` writes it as manifest.json. */
export interface AttachmentsOfTest {
  testIdentifier: string;
  attachments: { exportedFileName: string; suggestedHumanReadableName: string; timestamp?: number }[];
}

/** Numbers a version's parts, so 27.10 sorts after 27.9. */
function versionParts(version: string): number[] {
  return version.split('.').map((p) => Number(p) || 0);
}

function newerFirst(a: SimRuntime, b: SimRuntime): number {
  const [pa, pb] = [versionParts(a.version), versionParts(b.version)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  }
  return 0;
}

/**
 * The device type `written` names, on the newest of `runtimes` that runs it: an available
 * iOS runtime, of `version` when one is given. A version names a runtime by its whole
 * version or by its leading parts, so `27` names 27.0 and 27.1. Throws when no runtime is
 * available, none is of `version`, or none runs a device type of that name, naming the
 * nearest names they run.
 */
export function pickDevice(runtimes: SimRuntime[], written: string, version?: string): { deviceType: { identifier: string; name: string }; runtime: SimRuntime } {
  const ios = runtimes.filter((r) => r.isAvailable !== false && (r.platform === 'iOS' || r.identifier.includes('SimRuntime.iOS'))).sort(newerFirst);
  if (ios.length === 0) throw new Error('simulator: the host has no iOS Simulator runtime; Xcode installs one (Settings, Components)');
  const wanted = version ? ios.filter((r) => r.version === version || r.version.startsWith(`${version}.`)) : ios;
  if (wanted.length === 0) throw new Error(`simulator: the host has no iOS ${version} runtime; it has ${ios.map((r) => r.version).join(', ')}`);
  for (const runtime of wanted) {
    const types = runtime.supportedDeviceTypes ?? [];
    const name = deviceName(written, types.map((t) => t.name));
    const deviceType = types.find((t) => t.name === name);
    if (deviceType) return { deviceType, runtime };
  }
  const names = [...new Set(wanted.flatMap((r) => (r.supportedDeviceTypes ?? []).map((t) => t.name)))];
  const near = nearestNames(written, names).map((n) => `"${n}"`);
  const on = version ? `the host's iOS ${version} runtime runs` : "the host's iOS runtimes run";
  throw new Error(`simulator: "${written}" is not a device type ${on}${near.length ? `; the nearest are ${near.join(', ')}` : ''}`);
}

const UUID = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}';

/**
 * The name an attachment was given, from the name xcresulttool suggests for it, which
 * XCTest writes as `<name>_<n>_<UUID>.<extension>`. Characters a file name should not hold
 * become a dash. An attachment with no usable name is `screenshot`.
 */
export function attachmentName(suggested: string): string {
  const base = suggested.replace(/\.[A-Za-z0-9]+$/, '');
  const named = base.match(new RegExp(`^(.*)_\\d+_${UUID}$`, 'i'));
  return (named ? named[1] : base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'screenshot';
}

/**
 * The PNG attachments a manifest lists, in the order they were attached, each with a name
 * of its own in the pass. The first attachment a name is given to keeps it. A later one
 * given that name again takes the first of `-2`, `-3` and so on that no attachment of the
 * pass is given and none has taken, so a name a test gave, such as `board-2`, stays its
 * own. Names are told apart without regard to letter case, as a Mac's default volume
 * tells file names apart, so no two of them are one file there. Other attachments, such
 * as the screen recording XCTest makes of a failing test, are not screenshots and are
 * left out.
 */
export function screenshotsOf(manifest: AttachmentsOfTest[]): { name: string; file: string; test: string }[] {
  const pngs = manifest
    .flatMap((t) => t.attachments.map((a) => ({ ...a, test: t.testIdentifier })))
    .map((a, order) => ({ ...a, order }))
    .filter((a) => a.exportedFileName.toLowerCase().endsWith('.png'))
    .sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0) || a.order - b.order)
    .map((a) => ({ ...a, given: attachmentName(a.suggestedHumanReadableName) }));
  const fold = (name: string): string => name.toLowerCase();
  const given = new Set(pngs.map((a) => fold(a.given)));
  const taken = new Set<string>();
  return pngs.map((a) => {
    let name = a.given;
    if (taken.has(fold(name))) {
      let n = 2;
      while (given.has(fold(`${a.given}-${n}`)) || taken.has(fold(`${a.given}-${n}`))) n++;
      name = `${a.given}-${n}`;
    }
    taken.add(fold(name));
    return { name, file: a.exportedFileName, test: a.test };
  });
}

// ── Running Xcode's tools ──

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** The child processes and devices captures hold, so a signal that ends the process ends them too. */
const heldChildren = new Set<ChildProcess>();
const heldDevices = new Set<string>();
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * On a signal that would end the process: stop the children, delete the devices, and then,
 * when no other part of the program listens for the signal, raise it again so the process
 * ends as it would have.
 */
function onSignal(signal: NodeJS.Signals): void {
  for (const child of heldChildren) child.kill('SIGTERM');
  for (const udid of heldDevices) spawnSync('xcrun', ['simctl', 'delete', udid], { stdio: 'ignore', timeout: 60000 });
  heldDevices.clear();
  const others = process.listenerCount(signal) > 1;
  for (const s of SIGNALS) process.removeListener(s, onSignal);
  if (!others) process.kill(process.pid, signal);
}

/** Listen for the signals while anything is held, and only then. */
function watchSignals(): void {
  const listening = process.listeners('SIGINT').includes(onSignal);
  const holding = heldChildren.size + heldDevices.size > 0;
  if (holding && !listening) for (const s of SIGNALS) process.on(s, onSignal);
  if (!holding && listening) for (const s of SIGNALS) process.removeListener(s, onSignal);
}

function holdChild(child: ChildProcess): void {
  heldChildren.add(child);
  watchSignals();
}

function releaseChild(child: ChildProcess): void {
  heldChildren.delete(child);
  watchSignals();
}

/** Run `file` with `args` to its end. Its output is collected, or written to `logFile` when one is named. */
function run(file: string, args: string[], logFile?: string): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    holdChild(child);
    let stdout = '';
    let stderr = '';
    const log = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    child.stdout.on('data', (d: Buffer) => {
      if (log) log.write(d);
      else stdout += d;
    });
    child.stderr.on('data', (d: Buffer) => {
      if (log) log.write(d);
      else stderr += d;
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      releaseChild(child);
      log?.end();
      reject(e.code === 'ENOENT' ? new Error(`simulator: ${file} is not on PATH; the iOS Simulator needs macOS with Xcode installed`) : e);
    });
    child.on('close', (code, signal) => {
      releaseChild(child);
      const done = (): void => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
      if (log) log.end(done);
      else done();
    });
  });
}

/** The lines of `text` that say what went wrong: its error lines, or else its last lines. */
function whatWentWrong(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  const errors = lines.filter((l) => /\berror\b/i.test(l));
  return (errors.length ? errors : lines).slice(-QUOTED_LINES).map((l) => `  ${l}`).join('\n');
}

/** Run `xcrun simctl` with `args`, and throw when it fails, quoting what it said. */
async function simctl(args: string[], what: string): Promise<string> {
  const res = await run('xcrun', ['simctl', ...args]);
  if (res.code !== 0) throw new Error(`simulator: could not ${what}:\n${whatWentWrong(`${res.stderr}\n${res.stdout}`)}`);
  return res.stdout;
}

/** Run `xcrun xcresulttool` with `args`, and throw when it fails. */
async function xcresulttool(args: string[], what: string): Promise<string> {
  const res = await run('xcrun', ['xcresulttool', ...args]);
  if (res.code !== 0) throw new Error(`simulator: could not ${what}:\n${whatWentWrong(`${res.stderr}\n${res.stdout}`)}`);
  return res.stdout;
}

/** A recording of a device's screen, started once simctl says so. */
interface Recording {
  /** Stop recording and wait for the file to be written. True when it was. */
  stop(): Promise<boolean>;
}

/** Start recording `udid`'s screen into `file`, as H.264. Rejects when the recording does not start. */
function startRecording(udid: string, file: string): Promise<Recording> {
  return new Promise((resolve, reject) => {
    const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    holdChild(child);
    const exited = new Promise<void>((r) => child.on('close', () => r()));
    let said = '';
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      reject(new Error(`the recording did not start in ${RECORDING_START_MS / 1000}s`));
    }, RECORDING_START_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    void exited.then(() => {
      releaseChild(child);
      clearTimeout(timer);
      reject(new Error(`simctl stopped recording before it started: ${said.trim().split('\n').pop() ?? ''}`));
    });
    child.stderr.on('data', (d: Buffer) => {
      said += d;
      if (!said.includes('Recording started')) return;
      clearTimeout(timer);
      resolve({
        stop: async () => {
          child.kill('SIGINT');
          await exited;
          return existsSync(file) && statSync(file).size > 0;
        },
      });
    });
  });
}

/** The .xctestrun file a build for testing of `scheme` wrote into `products`: the newest, when it wrote more than one. */
function xctestrunIn(products: string, scheme: string): string {
  const found = existsSync(products) ? readdirSync(products).filter((f) => f.endsWith('.xctestrun') && f.startsWith(`${scheme}_`)) : [];
  if (found.length === 0) throw new Error(`simulator: the build wrote no .xctestrun file for the scheme ${scheme} into ${products}`);
  return found.map((f) => path.join(products, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

/** What a result bundle's summary says of the tests that ran. */
interface Summary {
  /** The run's result, such as `Passed` or `Failed`. */
  result?: string;
  passedTests?: number;
  failedTests?: number;
  skippedTests?: number;
  expectedFailures?: number;
  testFailures?: { testIdentifierString?: string; testName?: string; failureText?: string }[];
}

/** A word and its count, such as "2 screenshots". */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * Build the app (unless a build is handed over), then run its UI tests on a throwaway
 * device of the named type in each appearance, and save the screenshots they attach into
 * `outputDir`. Throws, saving nothing, when the options name no build or two, the output
 * directory holds files, the host runs no such device, the build fails, the tests cannot
 * run, xcodebuild fails the test run though no test failed, or the tests attach no
 * screenshot. Tests that fail are counted, not thrown.
 */
export async function captureSimulator(opts: CaptureSimulatorOptions): Promise<SimulatorResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const sources = [opts.project, opts.workspace, opts.xctestrun].filter(Boolean).length;
  if (sources !== 1) throw new Error('simulator: name the app to test once: a project or a workspace with its scheme, or the .xctestrun file of a build');
  if (!opts.xctestrun && !opts.scheme) throw new Error('simulator: a project or a workspace is built with a scheme; name the one whose test action holds the UI tests');
  for (const p of [opts.project, opts.workspace, opts.xctestrun]) {
    if (p && !existsSync(p)) throw new Error(`simulator: ${p} does not exist`);
  }
  const outputDir = path.resolve(opts.outputDir);
  claimOutputDir(outputDir, 'simulator');

  const runtimes = (JSON.parse(await simctl(['list', 'runtimes', '-j'], "list the host's simulator runtimes")) as { runtimes?: SimRuntime[] }).runtimes ?? [];
  const { deviceType, runtime } = pickDevice(runtimes, opts.device, opts.runtime);
  log(`simulator: ${deviceType.name} on ${runtime.name}, in ${APPEARANCES.join(' and ')}`);

  const capturesDir = path.join(path.resolve(opts.captureRoot ?? process.cwd()), '.captures', `simulator-${Date.now()}`);
  mkdirSync(capturesDir, { recursive: true });
  let saved = false;
  try {
    let xctestrun = opts.xctestrun ? path.resolve(opts.xctestrun) : '';
    if (!xctestrun) {
      const buildLog = path.join(capturesDir, 'build.log');
      const derivedData = path.join(capturesDir, 'DerivedData');
      const container = opts.workspace ? ['-workspace', path.resolve(opts.workspace)] : ['-project', path.resolve(opts.project as string)];
      log(`simulator: building ${opts.scheme} for testing (xcodebuild's log: ${buildLog})`);
      const built = await run('xcodebuild', ['build-for-testing', ...container, '-scheme', opts.scheme as string, '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derivedData, 'CODE_SIGNING_ALLOWED=NO'], buildLog);
      if (built.code !== 0) throw new Error(`simulator: the build failed:\n${whatWentWrong(readFileSync(buildLog, 'utf8'))}\n(xcodebuild's log: ${buildLog})`);
      xctestrun = xctestrunIn(path.join(derivedData, 'Build', 'Products'), opts.scheme as string);
    }

    const passes: SimulatorPass[] = [];
    for (const appearance of APPEARANCES) {
      passes.push(await runPass({ ...opts, outputDir }, appearance, deviceType.identifier, runtime.identifier, xctestrun, capturesDir, log));
    }
    const screenshots = passes.flatMap((p) => p.screenshots);
    if (screenshots.length === 0) throw new Error('simulator: the UI tests attached no screenshot; attach one at each step with XCTAttachment(screenshot: XCUIScreen.main.screenshot()), with a name');
    saved = true;
    const names = passes.map((p) => p.screenshots.map((s) => s.name).join(', '));
    if (new Set(names).size > 1) log(`simulator: the passes attached different screenshots: ${passes.map((p, i) => `${p.appearance} ${names[i] || 'none'}`).join('; ')}`);
    const failures = passes.reduce((n, p) => n + p.failedTests, 0);
    const keep = Boolean(opts.keep);
    return { device: deviceType.name, runtime: runtime.name, passes, screenshots, failures, capturesDir: keep ? capturesDir : null };
  } finally {
    // A run that throws saves nothing: what its passes wrote into the output directory,
    // which was empty when it began, goes. It keeps its working dir, so its build and test
    // logs can be read.
    if (!saved) for (const f of readdirSync(outputDir)) rmSync(path.join(outputDir, f), { recursive: true, force: true });
    if (saved && !opts.keep) rmSync(capturesDir, { recursive: true, force: true });
    else log(`simulator: working dir kept: ${capturesDir}`);
  }
}

/**
 * One appearance's pass, on a device of its own: create and boot it, fix its status bar,
 * set its appearance, grant the permissions asked for, run the tests while recording if
 * asked, save their screenshots, and delete the device however the pass ends.
 */
async function runPass(opts: CaptureSimulatorOptions, appearance: Appearance, deviceType: string, runtime: string, xctestrun: string, capturesDir: string, log: (m: string) => void): Promise<SimulatorPass> {
  const name = `sprintshow-${process.pid}-${appearance}-${Math.random().toString(16).slice(2, 6)}`;
  log(`simulator: ${appearance}: creating a throwaway device, ${name}`);
  const udid = (await simctl(['create', name, deviceType, runtime], `create a device of the type ${deviceType}`)).trim();
  heldDevices.add(udid);
  watchSignals();
  try {
    await simctl(['bootstatus', udid, '-b'], `boot the device ${udid}`);
    await simctl(['status_bar', udid, 'override', ...STATUS_BAR], "fix the device's status bar");
    await simctl(['ui', udid, 'appearance', appearance], `set the device's appearance to ${appearance}`);
    for (const bundle of opts.grant ?? []) await simctl(['privacy', udid, 'grant', 'all', bundle], `grant ${bundle} its permissions`);

    let recording: Recording | null = null;
    const videoFile = path.join(opts.outputDir, `${appearance}.mp4`);
    if (opts.video) {
      recording = await startRecording(udid, videoFile).catch((e: Error) => {
        log(`  · no video of this pass: ${e.message}`);
        return null;
      });
    }

    const bundle = path.join(capturesDir, `${appearance}.xcresult`);
    const testLog = path.join(capturesDir, `test-${appearance}.log`);
    log(`  · running the UI tests (xcodebuild's log: ${testLog})`);
    const only = (opts.tests ?? []).map((t) => `-only-testing:${t}`);
    let video: string | undefined;
    let tested: Ran;
    try {
      // Diagnostics stay off: on a failure, xcodebuild otherwise collects a sysdiagnose of
      // the device, which can take ten minutes.
      tested = await run('xcodebuild', ['test-without-building', '-xctestrun', xctestrun, '-destination', `platform=iOS Simulator,id=${udid}`, '-resultBundlePath', bundle, '-parallel-testing-enabled', 'NO', '-collect-test-diagnostics', 'never', ...only], testLog);
    } finally {
      if (recording) video = (await recording.stop()) ? videoFile : undefined;
    }
    if (recording && !video) log('  · no video of this pass: simctl wrote no file');

    if (!existsSync(bundle)) throw new Error(`simulator: the UI tests did not run:\n${whatWentWrong(readFileSync(testLog, 'utf8'))}\n(xcodebuild's log: ${testLog})`);
    const summary = JSON.parse(await xcresulttool(['get', 'test-results', 'summary', '--path', bundle], 'read the test results')) as Summary;
    const ran = (summary.passedTests ?? 0) + (summary.failedTests ?? 0) + (summary.expectedFailures ?? 0);
    if (ran === 0) throw new Error(`simulator: no test ran${opts.tests?.length ? `; check the tests named: ${opts.tests.join(', ')}` : ''}:\n${whatWentWrong(readFileSync(testLog, 'utf8'))}\n(xcodebuild's log: ${testLog})`);
    const failedTests = summary.failedTests ?? 0;
    // xcodebuild's exit status is its own verdict on the test run. A failed test that the
    // results count explains a non-zero exit. With none counted, the run failed in a way
    // the results do not show, so the pass fails rather than pass on the tests that passed.
    if (tested.code !== 0 && failedTests === 0) {
      const results = `${count(summary.passedTests ?? 0, 'test')} passed${summary.result ? `, result ${summary.result}` : ''}`;
      throw new Error(`simulator: the test run failed outside the tests: xcodebuild exited ${tested.code}, though the results count no failed test (${results}):\n${whatWentWrong(readFileSync(testLog, 'utf8'))}\n(xcodebuild's log: ${testLog})`);
    }
    const failures = (summary.testFailures ?? []).map((f) => `${f.testIdentifierString ?? f.testName ?? 'a test'}: ${f.failureText ?? 'failed'}`);
    if (failedTests > 0 && failures.length === 0) failures.push(`${count(failedTests, 'test')} failed`);

    const exported = path.join(capturesDir, `${appearance}-attachments`);
    await xcresulttool(['export', 'attachments', '--path', bundle, '--output-path', exported], 'export the screenshots the tests attached');
    const manifest = existsSync(path.join(exported, 'manifest.json')) ? (JSON.parse(readFileSync(path.join(exported, 'manifest.json'), 'utf8')) as AttachmentsOfTest[]) : [];
    // The output directory was empty when the run began and each name is the pass's own,
    // so a file already there is a fault to stop at, not a screenshot to write over.
    const screenshots = screenshotsOf(manifest).map((s) => {
      const file = path.join(opts.outputDir, `${s.name}.${appearance}.png`);
      copyFileSync(path.join(exported, s.file), file, constants.COPYFILE_EXCL);
      return { name: s.name, appearance, path: file, test: s.test };
    });

    if (failedTests === 0) log(`  ✓ ${count(ran, 'test')} passed`);
    else for (const f of failures) log(`  ✗ ${f}`);
    log(`  · ${count(screenshots.length, 'screenshot')}${screenshots.length ? `: ${screenshots.map((s) => s.name).join(', ')}` : ''}${video ? `, and the video ${path.basename(video)}` : ''}`);
    return { appearance, passed: failedTests === 0, failedTests, failures, screenshots, ...(video ? { video } : {}) };
  } finally {
    const deleted = await run('xcrun', ['simctl', 'delete', udid]).catch(() => null);
    heldDevices.delete(udid);
    watchSignals();
    log(deleted?.code === 0 ? '  · deleted the device' : `  · could not delete the device ${udid}; \`xcrun simctl delete ${udid}\` removes it`);
  }
}
