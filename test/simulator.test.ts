// Tests for the simulator capture (src/simulator.ts) and the `sprintshow simulator`
// command over it, with stand-ins for Xcode's tools (test/fake-xcode) first on PATH, so
// they run on any host. simulator-live.test.ts runs the real ones.
//
// The capture builds the app for testing unless handed a build, then runs the UI tests
// once in light and once in dark, each pass on a device of its own: created on the newest
// runtime that runs the named device type, booted, given a fixed status bar and the pass's
// appearance, and deleted once the pass ends, however it ends. Each PNG the tests attach is
// saved as <name>.<appearance>.png. A failed test still saves its screenshots and exits 3,
// and a capture that cannot finish leaves the output directory empty and exits 1. A signal
// that ends the process deletes the device first.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import { attachmentName, captureSimulator, pickDevice, screenshotsOf, STATUS_BAR, type CaptureSimulatorOptions, type SimRuntime } from '../src/simulator.ts';
import { scratchDir, runCli, REPO } from './browser-fixture.ts';

const FAKE = path.join(REPO, 'test', 'fake-xcode');
const quiet = (): void => {};

/** Every FAKE_XCODE_ variable the stand-ins read, so one test's setting never reaches the next. */
const FAKE_VARS = ['FAKE_XCODE_SCREENSHOTS', 'FAKE_XCODE_FAIL', 'FAKE_XCODE_NO_RESULT', 'FAKE_XCODE_HANG', 'FAKE_XCODE_BUILD_FAIL', 'FAKE_XCODE_NO_VIDEO'];

before(() => {
  process.env.PATH = `${FAKE}${path.delimiter}${process.env.PATH}`;
});

interface Call {
  tool: string;
  args: string[];
}

interface Fixture {
  dir: string;
  out: string;
  project: string;
  /** The calls the stand-ins took, in order. */
  calls(): Call[];
  /** The devices the stand-ins hold now, by UDID. */
  devices(): Record<string, { name: string; appearance: string; statusBar: string[] | null; grants: string[] }>;
}

/** A scratch directory with a stand-in project, a state directory for the stand-ins, and `env` set for the test. */
function fixture(t: { after(fn: () => void): void }, env: Record<string, string> = {}): Fixture {
  const { dir, cleanup } = scratchDir();
  const state = path.join(dir, 'state');
  const project = path.join(dir, 'Board.xcodeproj');
  mkdirSync(project);
  const saved = Object.fromEntries(['FAKE_XCODE_STATE', ...FAKE_VARS].map((k) => [k, process.env[k]]));
  for (const k of FAKE_VARS) delete process.env[k];
  Object.assign(process.env, { FAKE_XCODE_STATE: state, ...env });
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    cleanup();
  });
  const read = (file: string): string => (existsSync(path.join(state, file)) ? readFileSync(path.join(state, file), 'utf8') : '');
  return {
    dir,
    out: path.join(dir, 'shots'),
    project,
    calls: () =>
      read('calls.jsonl')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Call),
    devices: () => JSON.parse(read('devices.json') || '{}'),
  };
}

/** Capture with the stand-ins: the fixture's project and scheme, on an iPhone 17 Pro, unless `opts` says otherwise. */
function capture(f: Fixture, opts: Partial<CaptureSimulatorOptions> = {}, log: (m: string) => void = quiet) {
  return captureSimulator({ project: f.project, scheme: 'Board', device: 'iPhone 17 Pro', outputDir: f.out, captureRoot: f.dir, log, ...opts });
}

/** The colour of a 4x4 PNG the stand-ins wrote: white for light, black for dark. */
function shade(file: string): string {
  const [r] = PNG.sync.read(readFileSync(file)).data;
  return r === 255 ? 'white' : r === 0 ? 'black' : `rgb ${r}`;
}

/** A call to `simctl <sub>`, or to xcodebuild's `<sub>` action, by the first word of its arguments. */
const simctlCall = (c: Call): string | null => (c.tool === 'xcrun' && c.args[0] === 'simctl' ? c.args[1] : null);

describe('pickDevice', () => {
  const runtimes: SimRuntime[] = [
    { identifier: 'r26', name: 'iOS 26.0', version: '26.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 't16', name: 'iPhone 16' }, { identifier: 't17', name: 'iPhone 17 Pro' }] },
    { identifier: 'r27', name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 't17', name: 'iPhone 17 Pro' }, { identifier: 't18', name: 'iPhone 18 Pro' }] },
    { identifier: 'r27.10', name: 'iOS 27.10', version: '27.10', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 't18', name: 'iPhone 18 Pro' }] },
    { identifier: 'r28', name: 'iOS 28.0', version: '28.0', platform: 'iOS', isAvailable: false, supportedDeviceTypes: [{ identifier: 't17', name: 'iPhone 17 Pro' }] },
    { identifier: 'w12', name: 'watchOS 12.0', version: '12.0', platform: 'watchOS', isAvailable: true, supportedDeviceTypes: [{ identifier: 'tw', name: 'Apple Watch Ultra 4' }] },
  ];

  test('takes the newest available iOS runtime that runs the device type, whatever the case and spacing of its name', () => {
    const { deviceType, runtime } = pickDevice(runtimes, ' iphone  17 PRO ');
    assert.equal(deviceType.identifier, 't17');
    assert.equal(runtime.identifier, 'r27', 'iOS 28.0 is not available');
    assert.equal(pickDevice(runtimes, 'iPhone 18 Pro').runtime.identifier, 'r27.10', '27.10 is newer than 27.0');
    assert.equal(pickDevice(runtimes, 'iPhone 16').runtime.identifier, 'r26');
  });

  test('a version names a runtime by its whole version or its leading parts', () => {
    assert.equal(pickDevice(runtimes, 'iPhone 17 Pro', '26').runtime.identifier, 'r26');
    assert.equal(pickDevice(runtimes, 'iPhone 18 Pro', '27.0').runtime.identifier, 'r27');
    assert.throws(() => pickDevice(runtimes, 'iPhone 17 Pro', '25'), /the host has no iOS 25 runtime; it has 27\.10, 27\.0, 26\.0/);
    assert.throws(() => pickDevice(runtimes, 'iPhone 16', '27'), /"iPhone 16" is not a device type the host's iOS 27 runtime runs/);
  });

  test('a device type no runtime runs is refused, naming the nearest the runtimes run', () => {
    assert.throws(() => pickDevice(runtimes, 'iPhone 17 Pr'), /"iPhone 17 Pr" is not a device type the host's iOS runtimes run; the nearest are "iPhone 17 Pro", "iPhone 18 Pro", "iPhone 16"/);
    assert.throws(() => pickDevice(runtimes, 'Apple Watch Ultra 4'), /is not a device type/, 'a watchOS runtime is not an iOS one');
    assert.throws(() => pickDevice([runtimes[3], runtimes[4]], 'iPhone 17 Pro'), /the host has no iOS Simulator runtime/);
  });
});

describe('attachment names', () => {
  test('the name a test attached a screenshot with is what XCTest wrote before its counter and UUID', () => {
    assert.equal(attachmentName('01-board_0_F5D6F43C-C9BB-40A8-863E-8C8518C83096.png'), '01-board');
    assert.equal(attachmentName('home.v2_3_0a243a0a-11d2-4a88-8192-f41e9bf1d7f3.png'), 'home.v2');
    assert.equal(attachmentName('Library / empty state_0_0A243A0A-11D2-4A88-8192-F41E9BF1D7F3.png'), 'Library-empty-state');
    assert.equal(attachmentName('unexpected form.png'), 'unexpected-form');
    assert.equal(attachmentName('_0_0A243A0A-11D2-4A88-8192-F41E9BF1D7F3.png'), 'screenshot');
  });

  test('a pass keeps its PNG attachments in the order they were made, and numbers a name it already took', () => {
    const shots = screenshotsOf([
      {
        testIdentifier: 'A/testOne()',
        attachments: [
          { exportedFileName: 'B.png', suggestedHumanReadableName: '02-detail_0_0A243A0A-11D2-4A88-8192-F41E9BF1D7F3.png', timestamp: 20 },
          { exportedFileName: 'V.mp4', suggestedHumanReadableName: 'Screen Recording 2026-11-11 at 04.12.28 PM.mp4', timestamp: 5 },
          { exportedFileName: 'A.png', suggestedHumanReadableName: '01-home_0_0A243A0A-11D2-4A88-8192-F41E9BF1D7F3.png', timestamp: 10 },
          { exportedFileName: 'E', suggestedHumanReadableName: 'Synthesized Event 2026-11-11 at 04.12.35 PM', timestamp: 11 },
        ],
      },
      { testIdentifier: 'A/testTwo()', attachments: [{ exportedFileName: 'C.png', suggestedHumanReadableName: '01-home_0_1A243A0A-11D2-4A88-8192-F41E9BF1D7F3.png', timestamp: 30 }] },
    ]);
    assert.deepEqual(shots, [
      { name: '01-home', file: 'A.png', test: 'A/testOne()' },
      { name: '02-detail', file: 'B.png', test: 'A/testOne()' },
      { name: '01-home-2', file: 'C.png', test: 'A/testTwo()' },
    ]);
  });
});

describe('captureSimulator, with stand-ins for Xcode', () => {
  test('builds, runs the tests in light and then dark on a device each, and saves each screenshot by name and appearance', async (t) => {
    const f = fixture(t);
    const lines: string[] = [];
    const res = await capture(f, {}, (m) => lines.push(m));

    assert.deepEqual(readdirSync(f.out).sort(), ['01-board.dark.png', '01-board.light.png', '02-first-task-done.dark.png', '02-first-task-done.light.png']);
    assert.equal(shade(path.join(f.out, '01-board.light.png')), 'white');
    assert.equal(shade(path.join(f.out, '01-board.dark.png')), 'black');
    assert.equal(res.device, 'iPhone 17 Pro');
    assert.equal(res.runtime, 'iOS 27.0');
    assert.equal(res.failures, 0);
    assert.deepEqual(
      res.passes.map((p) => [p.appearance, p.passed, p.screenshots.map((s) => path.basename(s.path))]),
      [
        ['light', true, ['01-board.light.png', '02-first-task-done.light.png']],
        ['dark', true, ['01-board.dark.png', '02-first-task-done.dark.png']],
      ],
    );
    assert.equal(res.screenshots[0].test, 'BoardUITests/testBoard()');
    assert.deepEqual(f.devices(), {}, 'every device is deleted');
    assert.equal(res.capturesDir, null);
    assert.deepEqual(readdirSync(path.join(f.dir, '.captures')), [], 'the working dir is removed');

    const calls = f.calls();
    const build = calls.find((c) => c.tool === 'xcodebuild' && c.args[0] === 'build-for-testing') as Call;
    assert.deepEqual(build.args.slice(1, 7), ['-project', f.project, '-scheme', 'Board', '-destination', 'generic/platform=iOS Simulator']);
    assert.ok(build.args.includes('CODE_SIGNING_ALLOWED=NO'));
    // Each pass, in order: a device of its own, set up before the tests run, deleted after.
    const steps = calls.map((c) => simctlCall(c) ?? (c.tool === 'xcodebuild' ? c.args[0] : c.args[1])).filter((s) => s !== 'list');
    const pass = ['create', 'bootstatus', 'status_bar', 'ui', 'test-without-building', 'get', 'export', 'delete'];
    assert.deepEqual(steps, ['build-for-testing', ...pass, ...pass]);
    const creates = calls.filter((c) => simctlCall(c) === 'create');
    assert.equal(new Set(creates.map((c) => c.args[2])).size, 2, 'each pass names its device anew');
    assert.ok(creates.every((c) => c.args[2].startsWith(`sprintshow-${process.pid}-`)), 'a device is named for the process that made it');
    assert.deepEqual(creates[0].args.slice(3), ['com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro', 'com.apple.CoreSimulator.SimRuntime.iOS-27-0']);
    const statusBars = calls.filter((c) => simctlCall(c) === 'status_bar');
    assert.deepEqual(statusBars[0].args.slice(3), ['override', ...STATUS_BAR]);
    assert.deepEqual(
      calls.filter((c) => simctlCall(c) === 'ui').map((c) => c.args.slice(3)),
      [
        ['appearance', 'light'],
        ['appearance', 'dark'],
      ],
    );
    const tests = calls.filter((c) => c.tool === 'xcodebuild' && c.args[0] === 'test-without-building');
    for (const flag of [['-parallel-testing-enabled', 'NO'], ['-collect-test-diagnostics', 'never']]) {
      assert.equal(tests[0].args[tests[0].args.indexOf(flag[0]) + 1], flag[1], `${flag[0]} ${flag[1]}`);
    }
    assert.match(tests[0].args[tests[0].args.indexOf('-destination') + 1], /^platform=iOS Simulator,id=[0-9A-F-]{36}$/);
    assert.ok(lines.includes('  · 2 screenshots: 01-board, 02-first-task-done'), lines.join('\n'));
  });

  test('takes a build already made, runs only the tests named, and grants the permissions asked for before the tests', async (t) => {
    const f = fixture(t);
    const xctestrun = path.join(f.dir, 'Board_iphonesimulator27.0-arm64.xctestrun');
    writeFileSync(xctestrun, '<plist/>');
    await capture(f, { project: undefined, scheme: undefined, xctestrun, tests: ['BoardUITests/BoardUITests/testBoard', 'BoardUITests/Other'], grant: ['com.example.board'] });
    const calls = f.calls();
    assert.ok(!calls.some((c) => c.args[0] === 'build-for-testing'), 'no build');
    const test1 = calls.find((c) => c.args[0] === 'test-without-building') as Call;
    assert.equal(test1.args[test1.args.indexOf('-xctestrun') + 1], xctestrun);
    assert.deepEqual(
      test1.args.filter((a) => a.startsWith('-only-testing:')),
      ['-only-testing:BoardUITests/BoardUITests/testBoard', '-only-testing:BoardUITests/Other'],
    );
    const grant = calls.findIndex((c) => simctlCall(c) === 'privacy');
    assert.deepEqual(calls[grant].args.slice(3), ['grant', 'all', 'com.example.board']);
    assert.ok(grant < calls.indexOf(test1), 'granted before the tests run');
  });

  test('numbers a screenshot name a pass already took', async (t) => {
    const f = fixture(t, { FAKE_XCODE_SCREENSHOTS: JSON.stringify(['board', 'board', 'Done / now']) });
    await capture(f);
    assert.deepEqual(readdirSync(f.out).sort(), ['Done-now.dark.png', 'Done-now.light.png', 'board-2.dark.png', 'board-2.light.png', 'board.dark.png', 'board.light.png']);
  });

  test('records each pass when asked, from before the tests start until they end', async (t) => {
    const f = fixture(t);
    const res = await capture(f, { video: true });
    assert.deepEqual(
      res.passes.map((p) => p.video && path.basename(p.video)),
      ['light.mp4', 'dark.mp4'],
    );
    assert.equal(readFileSync(path.join(f.out, 'light.mp4'), 'utf8'), 'a fake video');
    const calls = f.calls();
    const record = calls.findIndex((c) => simctlCall(c) === 'io');
    assert.ok(record < calls.findIndex((c) => c.args[0] === 'test-without-building'));
  });

  test('a recording that does not start leaves the pass without a video, and says so', async (t) => {
    const f = fixture(t, { FAKE_XCODE_NO_VIDEO: '1' });
    const lines: string[] = [];
    const res = await capture(f, { video: true }, (m) => lines.push(m));
    assert.ok(res.passes.every((p) => p.video === undefined));
    assert.equal(res.screenshots.length, 4);
    assert.ok(lines.some((l) => /^ {2}· no video of this pass: simctl stopped recording before it started: Error: the display could not be found$/.test(l)), lines.join('\n'));
  });

  test('a test that fails keeps the screenshots it attached, and is counted', async (t) => {
    const f = fixture(t, { FAKE_XCODE_FAIL: 'dark' });
    const lines: string[] = [];
    const res = await capture(f, {}, (m) => lines.push(m));
    assert.equal(res.failures, 1);
    assert.deepEqual(
      res.passes.map((p) => [p.appearance, p.passed]),
      [
        ['light', true],
        ['dark', false],
      ],
    );
    assert.equal(readdirSync(f.out).length, 4);
    assert.ok(lines.includes('  ✗ BoardUITests/testBoard(): XCTAssertEqual failed: ("3 tasks · 2 done") is not equal to ("3 tasks · 3 done")'), lines.join('\n'));
    assert.deepEqual(f.devices(), {});
  });

  test('tests that cannot run fail the capture, which deletes the device and saves nothing', async (t) => {
    const f = fixture(t, { FAKE_XCODE_NO_RESULT: 'dark' });
    const lines: string[] = [];
    await assert.rejects(capture(f, {}, (m) => lines.push(m)), /the UI tests did not run:\n {2}xcodebuild: error: Failed to install or launch the test runner\.\n\(xcodebuild's log: .*test-dark\.log\)/);
    assert.deepEqual(readdirSync(f.out), [], "the light pass's screenshots go too");
    assert.deepEqual(f.devices(), {});
    const [kept] = readdirSync(path.join(f.dir, '.captures'));
    assert.ok(existsSync(path.join(f.dir, '.captures', kept, 'test-dark.log')), 'the working dir and its logs are kept');
    assert.ok(lines.some((l) => l.startsWith('simulator: working dir kept: ')), lines.join('\n'));
  });

  test('a build that fails quotes its errors, and creates no device', async (t) => {
    const f = fixture(t, { FAKE_XCODE_BUILD_FAIL: '1' });
    await assert.rejects(capture(f), /the build failed:\n {2}\/src\/Board\/BoardView\.swift:12:9: error: cannot find 'taks' in scope\n\(xcodebuild's log: .*build\.log\)/);
    assert.ok(!f.calls().some((c) => simctlCall(c) === 'create'));
    assert.deepEqual(readdirSync(f.out), []);
  });

  test('UI tests that attach no screenshot save nothing', async (t) => {
    const f = fixture(t, { FAKE_XCODE_SCREENSHOTS: '[]' });
    await assert.rejects(capture(f), /the UI tests attached no screenshot; attach one at each step with XCTAttachment/);
    assert.deepEqual(f.devices(), {});
  });

  test('refuses options it cannot capture with, before it creates a device or builds', async (t) => {
    const f = fixture(t);
    const xctestrun = path.join(f.dir, 'Board.xctestrun');
    writeFileSync(xctestrun, '<plist/>');
    await assert.rejects(capture(f, { project: undefined }), /name the app to test once/);
    await assert.rejects(capture(f, { xctestrun }), /name the app to test once/);
    await assert.rejects(capture(f, { scheme: undefined }), /built with a scheme/);
    await assert.rejects(capture(f, { project: path.join(f.dir, 'Absent.xcodeproj') }), /Absent\.xcodeproj does not exist/);
    await assert.rejects(capture(f, { device: 'iPhone 17 Pr' }), /"iPhone 17 Pr" is not a device type the host's iOS runtimes run; the nearest are "iPhone 17 Pro"/);
    await assert.rejects(capture(f, { runtime: '25' }), /the host has no iOS 25 runtime/);
    mkdirSync(f.out, { recursive: true });
    writeFileSync(path.join(f.out, 'old.png'), '');
    await assert.rejects(capture(f), /already holds files; name a new or empty directory/);
    assert.ok(!f.calls().some((c) => simctlCall(c) === 'create' || c.args[0] === 'build-for-testing'));
  });

  test('a device type an older runtime runs is created on that runtime', async (t) => {
    const f = fixture(t);
    const res = await capture(f, { device: 'iPhone 16' });
    assert.equal(res.runtime, 'iOS 26.0');
  });
});

describe('sprintshow simulator, with stand-ins for Xcode', () => {
  test('exits 0 when every test passed, and 3 when a test failed, its screenshots saved', async (t) => {
    const f = fixture(t);
    const ok = await runCli(['simulator', '--project', f.project, '--scheme', 'Board', '--device', 'iPhone 17 Pro', '-o', 'shots', '--test', 'BoardUITests/A', '--test', 'BoardUITests/B'], { cwd: f.dir });
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /✅ 4 screenshot\(s\) of iPhone 17 Pro on iOS 27\.0 → shots/);
    const test1 = f.calls().find((c) => c.args[0] === 'test-without-building') as Call;
    assert.deepEqual(
      test1.args.filter((a) => a.startsWith('-only-testing:')),
      ['-only-testing:BoardUITests/A', '-only-testing:BoardUITests/B'],
    );

    process.env.FAKE_XCODE_FAIL = 'light';
    const failed = await runCli(['simulator', '--project', f.project, '--scheme', 'Board', '--device', 'iPhone 17 Pro', '-o', 'second', '--video'], { cwd: f.dir });
    assert.equal(failed.code, 3, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /✅ 4 screenshot\(s\) and light\.mp4, dark\.mp4 of iPhone 17 Pro on iOS 27\.0 → second/);
    assert.match(failed.stdout, /⚠️ {2}1 UI test\(s\) failed — the screenshots they attached are saved/);
  });

  test('exits 1, saving nothing, when it cannot capture, and says what it needs', async (t) => {
    const f = fixture(t);
    const noDevice = await runCli(['simulator', '--project', f.project, '--scheme', 'Board', '-o', f.out], { cwd: f.dir });
    assert.equal(noDevice.code, 1);
    assert.match(noDevice.stderr, /a device type \(--device "iPhone 17 Pro"\) is required/);
    const script = await runCli(['simulator', 'demo.md', '--device', 'iPhone 17 Pro', '-o', f.out], { cwd: f.dir });
    assert.equal(script.code, 1);
    assert.match(script.stderr, /takes no demo script; the app's UI tests are its steps/);
    process.env.FAKE_XCODE_BUILD_FAIL = '1';
    const build = await runCli(['simulator', '--project', f.project, '--scheme', 'Board', '--device', 'iPhone 17 Pro', '-o', f.out], { cwd: f.dir });
    assert.equal(build.code, 1);
    assert.match(build.stderr, /✖ simulator: the build failed:/);
  });

  test('a signal that ends the capture deletes its device first', async (t) => {
    const f = fixture(t, { FAKE_XCODE_HANG: 'light' });
    const child = spawn(process.execPath, [path.join(REPO, 'src', 'cli.ts'), 'simulator', '--project', f.project, '--scheme', 'Board', '--device', 'iPhone 17 Pro', '-o', f.out], { cwd: f.dir, env: process.env });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 300 && !f.calls().some((c) => c.args[0] === 'test-without-building'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(Object.keys(f.devices()).length, 1, `a device is up while the tests run:\n${out}`);
    child.kill('SIGINT');
    const { signal } = await exited;
    assert.equal(signal, 'SIGINT', 'the process ends by the signal, as it would have');
    assert.deepEqual(f.devices(), {}, 'the device is deleted');
  });
});
