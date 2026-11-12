// A stand-in for the Xcode tools the simulator capture runs: `xcrun simctl`, `xcrun
// xcresulttool` and `xcodebuild`. The `xcrun` and `xcodebuild` beside it run this file, so
// a test that puts this directory first on PATH drives the capture on any host.
//
// It keeps its devices in $FAKE_XCODE_STATE/devices.json and appends each call, as
// {tool, args}, to $FAKE_XCODE_STATE/calls.jsonl. A test run on a device writes a result
// bundle holding what the run would have produced. Exporting its attachments writes a 4x4
// PNG for each screenshot, white in light and black in dark, so a test can tell which
// appearance a screenshot was taken in. The red of its last pixel is the screenshot's
// place among the ones the test attached, counting from 0, so a test can tell which
// screenshot a file holds.
//
// These variables change what it does:
//   FAKE_XCODE_SCREENSHOTS  a JSON array of the names the UI test attaches its screenshots
//                           with (default ["01-board", "02-first-task-done"])
//   FAKE_XCODE_FAIL         the appearance whose test run fails a test
//   FAKE_XCODE_ABORT        the appearance whose test run fails outside the tests: its
//                           test passes and the results count no failure, but xcodebuild
//                           says the run failed and exits 65
//   FAKE_XCODE_NO_RESULT    the appearance whose test run fails before any test runs
//   FAKE_XCODE_HANG         the appearance whose test run waits until it is killed
//   FAKE_XCODE_BUILD_FAIL   when set, the build fails
//   FAKE_XCODE_NO_VIDEO     when set, a recording stops before it starts

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(import.meta.dirname, '..', '..', 'package.json'));
const { PNG } = require('pngjs');

const STATE = process.env.FAKE_XCODE_STATE;
if (!STATE) {
  console.error('fake-xcode: FAKE_XCODE_STATE is not set');
  process.exit(2);
}
mkdirSync(STATE, { recursive: true });
const devicesFile = path.join(STATE, 'devices.json');
const devices = () => (existsSync(devicesFile) ? JSON.parse(readFileSync(devicesFile, 'utf8')) : {});
const saveDevices = (d) => writeFileSync(devicesFile, JSON.stringify(d, null, 2));

/** The runtimes the fake host has: iOS 26.0 and 27.0, an iOS 28.0 that is not available, and a watchOS runtime. */
const RUNTIMES = [
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', name: 'iOS 26.0', version: '26.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [type('iPhone 16'), type('iPhone 17 Pro')] },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-27-0', name: 'iOS 27.0', version: '27.0', platform: 'iOS', isAvailable: true, supportedDeviceTypes: [type('iPhone 17 Pro'), type('iPhone 18 Pro'), type('iPad Pro 13-inch (M5)')] },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-28-0', name: 'iOS 28.0', version: '28.0', platform: 'iOS', isAvailable: false, supportedDeviceTypes: [type('iPhone 19')] },
  { identifier: 'com.apple.CoreSimulator.SimRuntime.watchOS-12-0', name: 'watchOS 12.0', version: '12.0', platform: 'watchOS', isAvailable: true, supportedDeviceTypes: [type('Apple Watch Ultra 4')] },
];

function type(name) {
  return { name, identifier: `com.apple.CoreSimulator.SimDeviceType.${name.replace(/[^A-Za-z0-9]+/g, '-')}` };
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

/** A 4x4 PNG of `rgba` whose last pixel's red is `place`. */
function png(rgba, place) {
  const img = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  img.data[img.data.length - 4] = place;
  return PNG.sync.write(img);
}

/** The value after `flag` in `args`. */
const after = (args, flag) => args[args.indexOf(flag) + 1];

function simctl(args) {
  const [sub, ...rest] = args;
  const d = devices();
  const device = (udid) => d[udid] ?? fail(`An error was encountered processing the command (domain=com.apple.CoreSimulator.SimError, code=403): Invalid device: ${udid}`, 148);
  switch (sub) {
    case 'list':
      process.stdout.write(JSON.stringify({ runtimes: RUNTIMES }));
      return;
    case 'create': {
      const [name, deviceType, runtime] = rest;
      if (!RUNTIMES.some((r) => r.identifier === runtime && r.supportedDeviceTypes.some((t) => t.identifier === deviceType))) fail(`Invalid device type or runtime: ${deviceType} ${runtime}`, 162);
      const udid = randomUUID().toUpperCase();
      d[udid] = { name, deviceType, runtime, booted: false, appearance: 'light', statusBar: null, grants: [] };
      saveDevices(d);
      process.stdout.write(`${udid}\n`);
      return;
    }
    case 'bootstatus':
      device(rest[0]).booted = true;
      saveDevices(d);
      process.stdout.write('Monitoring boot status for fake.\nDevice already booted, nothing to do.\n');
      return;
    case 'status_bar':
      device(rest[0]).statusBar = rest.slice(2);
      saveDevices(d);
      return;
    case 'ui':
      device(rest[0]).appearance = rest[2];
      saveDevices(d);
      return;
    case 'privacy':
      device(rest[0]).grants.push(rest[3]);
      saveDevices(d);
      return;
    case 'delete':
      device(rest[0]);
      delete d[rest[0]];
      saveDevices(d);
      return;
    case 'io': {
      const file = rest[rest.length - 1];
      device(rest[0]);
      if (process.env.FAKE_XCODE_NO_VIDEO) fail('Error: the display could not be found', 1);
      process.stderr.write('Recording started\n');
      process.on('SIGINT', () => {
        writeFileSync(file, 'a fake video');
        process.stderr.write(`Wrote video to: ${file}\n`);
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      return;
    }
    default:
      fail(`fake-xcode: simctl ${sub} is not faked`, 64);
  }
}

function xcresulttool(args) {
  const bundle = after(args, '--path');
  const run = JSON.parse(readFileSync(path.join(bundle, 'fake.json'), 'utf8'));
  if (args[0] === 'get') {
    const failed = run.failed ? 1 : 0;
    process.stdout.write(
      JSON.stringify({
        result: failed ? 'Failed' : 'Passed',
        passedTests: 1 - failed,
        failedTests: failed,
        skippedTests: 0,
        expectedFailures: 0,
        testFailures: failed ? [{ testIdentifierString: 'BoardUITests/testBoard()', testName: 'testBoard()', failureText: 'XCTAssertEqual failed: ("3 tasks · 2 done") is not equal to ("3 tasks · 3 done")' }] : [],
      }),
    );
    return;
  }
  if (args[0] === 'export') {
    const out = after(args, '--output-path');
    mkdirSync(out, { recursive: true });
    const colour = run.appearance === 'dark' ? [0, 0, 0, 255] : [255, 255, 255, 255];
    const attachments = [];
    run.names.forEach((name, i) => {
      const file = `${randomUUID().toUpperCase()}.png`;
      writeFileSync(path.join(out, file), png(colour, i));
      attachments.push({ exportedFileName: file, suggestedHumanReadableName: `${name}_0_${randomUUID().toUpperCase()}.png`, timestamp: 1000 + i, isAssociatedWithFailure: false, configurationName: 'Test Scheme Action', deviceName: 'fake', deviceId: run.udid });
    });
    // XCTest's own attachments, which are not screenshots, come along as well.
    attachments.unshift({ exportedFileName: `${randomUUID().toUpperCase()}.mp4`, suggestedHumanReadableName: 'Screen Recording 2026-11-11 at 04.12.28 PM.mp4', timestamp: 999, isAssociatedWithFailure: false, configurationName: 'Test Scheme Action', deviceName: 'fake', deviceId: run.udid });
    // The manifest lists a test's attachments out of the order they were made in.
    attachments.reverse();
    writeFileSync(path.join(out, 'manifest.json'), JSON.stringify([{ testIdentifier: 'BoardUITests/testBoard()', attachments }], null, 2));
    return;
  }
  fail(`fake-xcode: xcresulttool ${args[0]} is not faked`, 64);
}

function xcodebuild(args) {
  if (args[0] === 'build-for-testing') {
    if (process.env.FAKE_XCODE_BUILD_FAIL) {
      console.log('/src/Board/BoardView.swift:12:9: error: cannot find \'taks\' in scope');
      console.log('** TEST BUILD FAILED **');
      process.exit(65);
    }
    const products = path.join(after(args, '-derivedDataPath'), 'Build', 'Products');
    mkdirSync(products, { recursive: true });
    writeFileSync(path.join(products, `${after(args, '-scheme')}_iphonesimulator27.0-arm64.xctestrun`), '<plist/>');
    console.log('** TEST BUILD SUCCEEDED **');
    return;
  }
  if (args[0] === 'test-without-building') {
    if (!existsSync(after(args, '-xctestrun'))) fail(`xcodebuild: error: The file ${after(args, '-xctestrun')} does not exist.`, 66);
    const udid = after(args, '-destination').match(/id=([^,]+)/)[1];
    const device = devices()[udid];
    if (!device?.booted) fail(`xcodebuild: error: Unable to find a destination matching the provided destination specifier: id=${udid}`, 70);
    const { appearance } = device;
    if (process.env.FAKE_XCODE_HANG === appearance) {
      console.log('Testing started');
      setInterval(() => {}, 1000);
      return;
    }
    if (process.env.FAKE_XCODE_NO_RESULT === appearance) fail('xcodebuild: error: Failed to install or launch the test runner.', 70);
    const bundle = after(args, '-resultBundlePath');
    mkdirSync(bundle, { recursive: true });
    const failed = process.env.FAKE_XCODE_FAIL === appearance;
    const aborted = process.env.FAKE_XCODE_ABORT === appearance;
    const names = JSON.parse(process.env.FAKE_XCODE_SCREENSHOTS ?? '["01-board", "02-first-task-done"]');
    writeFileSync(path.join(bundle, 'fake.json'), JSON.stringify({ udid, appearance, failed, names }));
    if (aborted) console.log('xcodebuild: error: The test runner stopped before the test run finished.');
    console.log(failed || aborted ? '** TEST EXECUTE FAILED **' : '** TEST EXECUTE SUCCEEDED **');
    process.exit(failed || aborted ? 65 : 0);
  }
  fail(`fake-xcode: xcodebuild ${args[0]} is not faked`, 64);
}

/** Run the tool this file was started as. */
export function main(tool) {
  const args = process.argv.slice(2);
  appendFileSync(path.join(STATE, 'calls.jsonl'), `${JSON.stringify({ tool, args })}\n`);
  if (tool === 'xcodebuild') return xcodebuild(args);
  const [sub, ...rest] = args;
  if (sub === 'simctl') return simctl(rest);
  if (sub === 'xcresulttool') return xcresulttool(rest);
  fail(`xcrun: error: unable to find utility "${sub}", not a developer tool or in PATH`, 72);
}
