#!/usr/bin/env node
// The sample iOS app's start command, as a repository gives one to `sprintshow run --serve`:
//
//   sprintshow run demos/ios.md --serve "node examples/sample-ios/serve.mjs"
//
// It builds the app for the iOS Simulator, or takes the build named as its argument. It
// creates a device of its own, the first iPhone the newest iOS runtime lists, boots it,
// installs the app and launches it. Then it prints the app's simulator URL,
// ios-simulator://<device UDID>/<bundle id>, on its standard output, which tells sprintshow
// that the app is up and where. Everything else it prints goes to its standard error. It
// runs until it is stopped with SIGTERM, SIGINT or SIGHUP, and then deletes its device, so
// two of it never share a device.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUNDLE_ID = 'com.zookanalytics.sprintshow.SprintBoard';
const here = path.dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(path.join(tmpdir(), 'sprintboard-'));
let udid = null;

/** Run a tool, its output kept off this command's standard output, and return what it printed there. */
const run = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

const cleanup = () => {
  if (udid) spawnSync('xcrun', ['simctl', 'delete', udid], { stdio: 'ignore' });
  udid = null;
  rmSync(work, { recursive: true, force: true });
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    cleanup();
    process.exit(0);
  });
}

try {
  let app = process.argv[2] ? path.resolve(process.argv[2]) : null;
  if (!app) {
    console.error('sample-ios: building SprintBoard for the iOS Simulator…');
    run('xcodebuild', [
      'build',
      '-project', path.join(here, 'SprintBoard.xcodeproj'),
      '-scheme', 'SprintBoard',
      '-configuration', 'Debug',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', path.join(work, 'derived'),
      '-quiet',
      'CODE_SIGNING_ALLOWED=NO',
    ]);
    app = path.join(work, 'derived', 'Build', 'Products', 'Debug-iphonesimulator', 'SprintBoard.app');
  }
  const runtimes = JSON.parse(run('xcrun', ['simctl', 'list', 'runtimes', '--json'])).runtimes.filter((r) => r.platform === 'iOS' && r.isAvailable);
  const newest = (a, b) => a.version.localeCompare(b.version, undefined, { numeric: true });
  const runtime = runtimes.sort(newest).pop();
  if (!runtime) throw new Error('this host has no iOS Simulator runtime; install one in Xcode');
  const type = runtime.supportedDeviceTypes.find((t) => t.productFamily === 'iPhone');
  udid = run('xcrun', ['simctl', 'create', `sprintboard-${process.pid}`, type.identifier, runtime.identifier]).trim();
  console.error(`sample-ios: booting ${type.name} on iOS ${runtime.version} (${udid})…`);
  run('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  run('xcrun', ['simctl', 'install', udid, app]);
  run('xcrun', ['simctl', 'launch', udid, BUNDLE_ID]);
  console.log(`ios-simulator://${udid}/${BUNDLE_ID}`);
} catch (e) {
  cleanup();
  console.error(`sample-ios: ${e.message}`);
  process.exit(1);
}

// Run until a signal stops it.
setInterval(() => {}, 1 << 30);
