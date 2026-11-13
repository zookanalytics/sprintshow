// Tests for the parts of src/simulator.ts that need no simulator: how a simulator URL
// names an app, the environment every tool the engine starts for an iOS app gets, and
// how the status bar's overrides are read from simctl's listing. test/ios-live.test.ts
// drives a real device.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isSimulatorUrl, parseSimulatorUrl, simulatorUrl, statusBarOverrides, toolEnv } from '../src/simulator.ts';

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

test('a tool the engine starts for an iOS app gets the engine environment less the keys the engine holds', () => {
  const env = toolEnv({ PATH: '/usr/bin', HOME: '/home/a', DEVELOPER_DIR: '/Applications/Xcode.app', VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass', OPENAI_API_KEY: 'speech', UNSET: undefined });
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/a', DEVELOPER_DIR: '/Applications/Xcode.app' });
});

test("the status bar's overrides are the lines simctl lists under its heading's rule", () => {
  assert.deepEqual(statusBarOverrides('Current Status Bar Overrides:\n=============================\n'), []);
  assert.deepEqual(statusBarOverrides('Current Status Bar Overrides:\n=============================\nTime: 9:41 \nWiFi Mode: 3, WiFi Bars: 3\n'), ['Time: 9:41', 'WiFi Mode: 3, WiFi Bars: 3']);
});
