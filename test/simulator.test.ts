// Tests for the parts of src/simulator.ts that need no simulator: how a simulator URL
// names an app, alone or among other text, the environment every tool the engine starts
// for an iOS app gets, how the status bar's overrides are read from simctl's listing, and
// how the host's Simulator UI is found running, from an Xcode's apps, on macOS.
// test/ios-live.test.ts drives a real device.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { findSimulatorUrl, isSimulatorUrl, parseSimulatorUrl, simulatorUiRuns, simulatorUrl, statusBarOverrides, toolEnv } from '../src/simulator.ts';

const UDID = '265F099F-E558-4E32-82BE-F70A75EC0716';

test('a simulator URL names a device by its UDID and an app by its bundle identifier', () => {
  assert.deepEqual(parseSimulatorUrl(`ios-simulator://${UDID}/com.example.Board`), { udid: UDID, bundleId: 'com.example.Board' });
  // The scheme and the UDID in any letter case, and a trailing slash, name the same app.
  assert.deepEqual(parseSimulatorUrl(`IOS-Simulator://${UDID.toLowerCase()}/com.example.Board/`), { udid: UDID, bundleId: 'com.example.Board' });
  assert.equal(simulatorUrl({ udid: UDID, bundleId: 'com.example.Board' }), `ios-simulator://${UDID}/com.example.Board`);
  assert.equal(isSimulatorUrl(` ios-simulator://whatever`), true);
  assert.equal(isSimulatorUrl('http://localhost:3000'), false);
});

test('a URL with no device UDID, no bundle identifier, or anything past them is not a simulator URL', () => {
  for (const url of [
    'http://localhost:3000',
    `ios-simulator://${UDID}`,
    `ios-simulator://${UDID}/`,
    'ios-simulator://booted/com.example.Board',
    `ios-simulator://${UDID.slice(1)}/com.example.Board`,
    `ios-simulator://${UDID}/com.example.Board/more`,
    `ios-simulator://${UDID}/com.example.Board?launch=1`,
    `ios-simulator://${UDID}/com example`,
    `ios-simulator://${UDID}/.com.example`,
  ]) {
    assert.equal(parseSimulatorUrl(url), null, url);
  }
});

test('a simulator URL among other text ends with its bundle identifier, and one that goes on past it names no app', () => {
  const app = { udid: UDID, bundleId: 'com.example.Board' };
  for (const line of [
    `ios-simulator://${UDID}/com.example.Board`,
    `App ready: ios-simulator://${UDID}/com.example.Board.`,
    `{"url":"ios-simulator://${UDID}/com.example.Board"}`,
    `ready (ios-simulator://${UDID.toLowerCase()}/com.example.Board/), at last`,
    `\x1b[32mios-simulator://${UDID}/com.example.Board\x1b[0m`,
    `a path, ios-simulator://${UDID}/com.example.Board/more, then the app: ios-simulator://${UDID}/com.example.Board`,
  ]) {
    assert.deepEqual(findSimulatorUrl(line), app, line);
  }
  for (const line of [
    'booting a device',
    `ios-simulator://${UDID}/com.example.Board/more`,
    `ios-simulator://${UDID}/com.example.Board?launch=1`,
    `ios-simulator://${UDID}/com.example.Board#top`,
    `ios-simulator://${UDID}/com.example.Board_debug`,
    'ios-simulator://booted/com.example.Board',
    `ios-simulator://${UDID}/`,
  ]) {
    assert.equal(findSimulatorUrl(line), null, line);
  }
});

test('a tool the engine starts for an iOS app gets the engine environment less the keys the engine holds', () => {
  const env = toolEnv({ PATH: '/usr/bin', HOME: '/home/a', DEVELOPER_DIR: '/Applications/Xcode.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass', OPENAI_API_KEY: 'speech', UNSET: undefined });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/a', DEVELOPER_DIR: '/Applications/Xcode.app' });
});

test("the status bar's overrides are the lines simctl lists under its heading's rule", () => {
  assert.deepEqual(statusBarOverrides('Current Status Bar Overrides:\n=============================\n'), []);
  assert.deepEqual(statusBarOverrides('Current Status Bar Overrides:\n=============================\nTime: 9:41 \nWiFi Mode: 3, WiFi Bars: 3\n'), ['Time: 9:41', 'WiFi Mode: 3, WiFi Bars: 3']);
});

/** Write an XML property list of `values` to `file`, making its directory. */
function writePlist(file: string, values: Record<string, string>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const entries = Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${value}</string>`);
  writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${entries.join('')}</dict></plist>\n`);
}

/** A process whose command line holds `file`, as an app's process holds its executable's path. Resolves once it runs. */
function runFrom(file: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', file], { stdio: 'ignore' });
    child.once('spawn', () => resolve(child)).once('error', reject);
  });
}

/** End `child`, and resolve once it has exited. */
function end(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
  });
}

test("the host's Simulator UI runs when a process runs from the active Xcode's UI app: DeviceHub beside its developer directory from Xcode 27 on, and Simulator inside it before", { skip: process.platform !== 'darwin' && "needs macOS, whose plutil reads an app's property list" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sprintshow-xcode-'));
  try {
    // An Xcode 27, an Xcode 26, and an Xcode 27 whose app where DeviceHub would be is another.
    const xcodes = [
      { name: 'Xcode-27.app', version: '27.0', folder: 'Applications', app: 'DeviceHub', bundleId: 'com.apple.dt.Devices', ui: true },
      { name: 'Xcode-26.app', version: '26.4', folder: path.join('Developer', 'Applications'), app: 'Simulator', bundleId: 'com.apple.iphonesimulator', ui: true },
      { name: 'Xcode-27.1.app', version: '27.1', folder: 'Applications', app: 'Instruments', bundleId: 'com.apple.dt.Instruments', ui: false },
    ];
    const appOf = (x: (typeof xcodes)[number]): string => path.join(dir, x.name, 'Contents', x.folder, `${x.app}.app`);
    for (const x of xcodes) {
      writePlist(path.join(dir, x.name, 'Contents', 'Info.plist'), { CFBundleShortVersionString: x.version });
      writePlist(path.join(appOf(x), 'Contents', 'Info.plist'), { CFBundleIdentifier: x.bundleId });
    }
    const runs = (): Promise<boolean[]> => Promise.all(xcodes.map((x) => simulatorUiRuns({ DEVELOPER_DIR: path.join(dir, x.name, 'Contents', 'Developer') })));

    assert.deepEqual(await runs(), [false, false, false], 'no app runs');
    for (const [i, x] of xcodes.entries()) {
      const running = await runFrom(path.join(appOf(x), 'Contents', 'MacOS', x.app));
      try {
        assert.deepEqual(await runs(), xcodes.map((_, j) => j === i && x.ui), `${x.app} runs, from ${x.name}`);
      } finally {
        await end(running);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
