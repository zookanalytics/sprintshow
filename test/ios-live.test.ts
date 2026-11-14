// Live tests of an iOS app script: demos/ios.md, driven through Appium on a real iOS
// Simulator device, against the sample app (examples/sample-ios). They run where a capture
// of an iOS app can, on macOS with Xcode, an iOS Simulator runtime, and Appium and its
// runner app provisioned, and skip elsewhere with the reason, as CI's Linux runners do.
// There, test/ios.test.ts drives the surface against a stand-in.
//
// The first test does what a caller does with an app already running: it builds the
// sample, creates and boots a device of its own, installs and launches the app, and hands
// sprintshow the app's simulator URL as --base-url. The device is set dark first, so the
// run's light appearance and its putting the device back both show. The second hands
// sprintshow the sample's start command as --serve, which brings the app up on a device of
// its own and deletes the device once sprintshow stops it.
//
// Each run must save its MP4 and a PNG of each step, at the device's own size, and leave
// the device as it was given: the app installed and running in the same process, no
// runner app, and its appearance and status bar as before.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDemoScript } from '../src/demo-script.ts';
import { stepFileName } from '../src/screenshot.ts';
import { ffmpegBin, probeDuration } from '../src/ffmpeg.ts';
import { simulatorUrl, statusBarOverrides, toolEnv, userApps } from '../src/simulator.ts';
import { runnerApp, RUNNER_BUNDLE_NAME } from '../src/webdriveragent.ts';
import { launchBrowser, scratchDir, runCli, pngSize, pngPixels, REPO } from './browser-fixture.ts';

const BUNDLE_ID = 'com.zookanalytics.sprintshow.SprintBoard';
const DEMO = path.join(REPO, 'demos', 'ios.md');
const STEPS = parseDemoScript(readFileSync(DEMO, 'utf8')).steps;

/** Run a tool with the environment the engine gives its iOS tools, and return what it printed. */
const tool = (command: string, args: string[]): string => execFileSync(command, args, { encoding: 'utf8', env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
const simctl = (...args: string[]): string => tool('xcrun', ['simctl', ...args]);

interface Runtime {
  identifier: string;
  version: string;
  platform: string;
  isAvailable: boolean;
  supportedDeviceTypes: { identifier: string; name: string; productFamily: string }[];
}

/** The newest iOS Simulator runtime on this host, or null. */
function newestRuntime(): Runtime | null {
  const runtimes = (JSON.parse(simctl('list', 'runtimes', '--json')) as { runtimes: Runtime[] }).runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable);
  return runtimes.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true })).pop() ?? null;
}

/** Why the live tests cannot run on this host, or false when they can. */
async function liveSkip(): Promise<string | false> {
  if (process.platform !== 'darwin') return 'needs macOS with Xcode and an iOS Simulator runtime';
  try {
    if (!newestRuntime()) return 'this host has no iOS Simulator runtime';
  } catch {
    return 'needs Xcode: `xcrun simctl` did not run';
  }
  try {
    await runnerApp();
  } catch (e) {
    return (e as Error).message;
  }
  if (!ffmpegBin()) return 'ffmpeg un-provisioned — `npm run provision:ffmpeg`';
  const { browser, skip } = await launchBrowser();
  await browser?.close();
  return skip;
}

const skip = await liveSkip();

/** The process the app runs in on device `udid`, or null when it is not running. */
function appProcess(udid: string): number | null {
  const line = simctl('spawn', udid, 'launchctl', 'list')
    .split('\n')
    .find((l) => l.includes(`UIKitApplication:${BUNDLE_ID}`));
  const pid = Number(line?.trim().split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Check that a run saved its video, and a PNG of each step at the device's size, light as a run sets the appearance. */
async function checkOutputs(video: string, shots: string): Promise<void> {
  assert.ok(probeDuration(video) > 5, `${video} is a video of the walk`);
  assert.deepEqual(readdirSync(shots).sort(), STEPS.map((s) => stepFileName(s, STEPS.length)));
  const sizes = readdirSync(shots).map((f) => pngSize(path.join(shots, f)));
  for (const size of sizes) assert.deepEqual(size, sizes[0], 'every PNG is the device screen at its own size');
  assert.ok(sizes[0].height > sizes[0].width * 1.5, `a phone's screen in portrait, not the engine's frame: ${JSON.stringify(sizes[0])}`);
  // The board's background, below the summary: light, though the device was dark.
  const [[r, g, b]] = await pngPixels(path.join(shots, readdirSync(shots).sort()[0]), [{ x: Math.round(sizes[0].width / 2), y: Math.round(sizes[0].height * 0.6) }]);
  assert.ok(r > 200 && g > 200 && b > 200, `the run's appearance is light: rgb(${r},${g},${b})`);
}

describe('an iOS app on a simulator, through Appium', { skip }, () => {
  const { dir, cleanup } = scratchDir();
  const app = path.join(dir, 'derived', 'Build', 'Products', 'Debug-iphonesimulator', 'SprintBoard.app');
  let udid = '';
  let pid: number | null = null;

  before(async () => {
    tool('xcodebuild', [
      'build',
      '-project', path.join(REPO, 'examples', 'sample-ios', 'SprintBoard.xcodeproj'),
      '-scheme', 'SprintBoard',
      '-configuration', 'Debug',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', path.join(dir, 'derived'),
      '-quiet',
      'CODE_SIGNING_ALLOWED=NO',
    ]);
    const runtime = newestRuntime() as Runtime;
    const type = runtime.supportedDeviceTypes.find((t) => t.productFamily === 'iPhone');
    assert.ok(type, `iOS ${runtime.version} runs no iPhone`);
    udid = simctl('create', `sprintshow-live-${process.pid}`, type.identifier, runtime.identifier).trim();
    simctl('bootstatus', udid, '-b');
    simctl('install', udid, app);
    simctl('launch', udid, BUNDLE_ID);
    simctl('ui', udid, 'appearance', 'dark');
    pid = appProcess(udid);
    assert.ok(pid, 'the app runs');
  });

  after(() => {
    if (udid) simctl('delete', udid);
    cleanup();
  });

  test('--base-url: an app already running is filmed with a PNG of each step, and the device is left as it was given', async () => {
    const before = { appearance: simctl('ui', udid, 'appearance').trim(), overrides: statusBarOverrides(simctl('status_bar', udid, 'list')) };
    assert.deepEqual(before, { appearance: 'dark', overrides: [] });
    const out = path.join(dir, 'base-url');
    const run = await runCli(['run', DEMO, '--base-url', simulatorUrl({ udid, bundleId: BUNDLE_ID }), '--no-narrate', '--screenshots', path.join(out, 'shots'), '-o', path.join(out, 'ios.mp4')], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: '' } });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    assert.equal((run.stdout.match(/✓ proof held/g) ?? []).length, STEPS.length, run.stdout);
    await checkOutputs(path.join(out, 'ios.mp4'), path.join(out, 'shots'));

    assert.deepEqual({ appearance: simctl('ui', udid, 'appearance').trim(), overrides: statusBarOverrides(simctl('status_bar', udid, 'list')) }, before);
    assert.deepEqual((await userApps(udid)).filter((a) => a.name === RUNNER_BUNDLE_NAME), [], 'the runner app is removed');
    assert.ok((await userApps(udid)).some((a) => a.bundleId === BUNDLE_ID), 'the app is still installed');
    assert.equal(appProcess(udid), pid, 'the app runs in the process it ran in before');
  });

  test("--serve: the repo's command brings the app up on a device of its own, and the device is gone once the run ends", async () => {
    const out = path.join(dir, 'serve');
    const serve = `node ${JSON.stringify(path.join(REPO, 'examples', 'sample-ios', 'serve.mjs'))} ${JSON.stringify(app)}`;
    const run = await runCli(['run', DEMO, '--serve', serve, '--mode', 'proof', '--no-narrate', '--screenshots', path.join(out, 'shots'), '-o', path.join(out, 'ios.mp4')], { cwd: dir, env: { ...process.env, OPENAI_API_KEY: '' } });
    assert.equal(run.code, 0, run.stdout + run.stderr);
    const served = run.stdout.match(/app: ready at ios-simulator:\/\/([0-9A-F-]{36})\//)?.[1];
    assert.ok(served, run.stdout);
    assert.notEqual(served, udid);
    await checkOutputs(path.join(out, 'ios.mp4'), path.join(out, 'shots'));
    assert.ok(!simctl('list', 'devices').includes(served), `the command deleted its device ${served}`);
    assert.ok(existsSync(app), "the build the command took is the caller's, and stays");
  });
});
