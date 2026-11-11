// The simulator capture with Xcode's own tools, on the bundled sample app
// (examples/sample-ios): its UI test taps a task done and attaches a screenshot before and
// after. simulator.test.ts covers the capture's paths with stand-ins for the tools.
//
// One capture builds the sample and records each pass, and its screenshots become golden
// images. A second capture of the same build, on devices of its own, matches them, so a
// screenshot does not change from one run to the next. A golden image changed on purpose
// then makes the comparison fail with a diff image. No device a capture made outlives it.
//
// It needs macOS with Xcode and an iOS Simulator runtime that runs an iPhone, and skips
// without them. It takes a few minutes: each capture boots two devices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

import type { SimRuntime } from '../src/simulator.ts';
import { scratchDir, runCli, REPO } from './browser-fixture.ts';

const PROJECT = path.join(REPO, 'examples', 'sample-ios', 'SprintBoard.xcodeproj');
const SHOTS = ['01-board.dark.png', '01-board.light.png', '02-first-task-done.dark.png', '02-first-task-done.light.png'];

/** An iPhone the newest iOS runtime the host has runs, or why the test skips. */
function hostIphone(): { device: string; skip: false } | { device: null; skip: string } {
  if (process.platform !== 'darwin') return { device: null, skip: 'the iOS Simulator needs macOS' };
  const listed = spawnSync('xcrun', ['simctl', 'list', 'runtimes', '-j'], { encoding: 'utf8' });
  if (listed.status !== 0) return { device: null, skip: 'no Xcode with simctl on this host' };
  const runtimes = ((JSON.parse(listed.stdout) as { runtimes?: SimRuntime[] }).runtimes ?? []).filter((r) => r.platform === 'iOS' && r.isAvailable !== false);
  const newest = runtimes.sort((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))[0];
  const iphone = (newest?.supportedDeviceTypes as { name: string; productFamily?: string }[] | undefined)?.find((t) => t.productFamily === 'iPhone');
  return iphone ? { device: iphone.name, skip: false } : { device: null, skip: 'no iOS Simulator runtime that runs an iPhone on this host' };
}

/** The names of the devices a capture's log says it created. */
function devicesMade(log: string): string[] {
  return [...log.matchAll(/creating a throwaway device, (\S+)/g)].map((m) => m[1]);
}

/** The names of the simulator devices the host has now. */
function hostDevices(): string[] {
  const listed = spawnSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' });
  return Object.values((JSON.parse(listed.stdout) as { devices: Record<string, { name: string }[]> }).devices).flatMap((ds) => ds.map((d) => d.name));
}

const read = (file: string): PNG => PNG.sync.read(readFileSync(file));

const { device, skip } = hostIphone();

test('the sample app, captured in light and dark on throwaway devices, matches its golden images on a second run', { skip, timeout: 20 * 60 * 1000 }, async (t) => {
  const { dir, cleanup } = scratchDir();
  t.after(cleanup);

  const first = await runCli(['simulator', '--project', PROJECT, '--scheme', 'SprintBoard', '--device', device as string, '-o', 'shots', '--video', '--keep'], { cwd: dir });
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const shots = path.join(dir, 'shots');
  assert.deepEqual(readdirSync(shots).sort(), [...SHOTS, 'dark.mp4', 'light.mp4'].sort());
  for (const video of ['light.mp4', 'dark.mp4']) assert.ok(statSync(path.join(shots, video)).size > 0, `${video} holds a recording`);

  // Light and dark show the same screen in other colours: the background behind the list
  // is light in one and black in the other.
  const [light, dark] = [read(path.join(shots, '01-board.light.png')), read(path.join(shots, '01-board.dark.png'))];
  assert.deepEqual([light.width, light.height], [dark.width, dark.height]);
  const background = (img: PNG): number => img.data[(img.width * Math.floor(img.height * 0.8) + 10) * 4];
  assert.ok(background(light) > 200 && background(dark) < 40, `light ${background(light)}, dark ${background(dark)}`);
  // Tapping the first task changes the screen.
  const done = read(path.join(shots, '02-first-task-done.light.png'));
  assert.ok(pixelmatch(light.data, done.data, null, light.width, light.height) > 100, 'the second step shows the task done');

  const golden = path.join(dir, 'golden');
  assert.equal((await runCli(['golden', 'shots', 'golden', '--update'], { cwd: dir })).code, 0);
  assert.deepEqual(readdirSync(golden).sort(), SHOTS);

  // A second run of the same build, on devices of its own, matches the golden images.
  const captures = path.join(dir, '.captures');
  const [kept] = readdirSync(captures);
  const products = path.join(captures, kept, 'DerivedData', 'Build', 'Products');
  const xctestrun = path.join(products, readdirSync(products).find((f) => f.endsWith('.xctestrun')) as string);
  const second = await runCli(['simulator', '--xctestrun', xctestrun, '--device', device as string, '--test', 'SprintBoardUITests/SprintBoardUITests/testBoard', '-o', 'again'], { cwd: dir });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const compared = await runCli(['golden', 'again', 'golden'], { cwd: dir });
  assert.equal(compared.code, 0, compared.stdout + compared.stderr);

  // A golden image changed on purpose, a box painted on the plain background below the
  // list, makes the comparison fail with a diff image.
  const changed = read(path.join(golden, '01-board.light.png'));
  const top = Math.floor(changed.height * 0.6);
  for (let y = top; y < top + 100; y++) for (let x = 100; x < 300; x++) changed.data.set([255, 0, 255, 255], (y * changed.width + x) * 4);
  writeFileSync(path.join(golden, '01-board.light.png'), PNG.sync.write(changed));
  const failed = await runCli(['golden', 'again', 'golden'], { cwd: dir });
  assert.equal(failed.code, 3, failed.stdout + failed.stderr);
  assert.match(failed.stdout, /✗ 01-board\.light\.png: 20,000 pixels differ → /);
  assert.ok(existsSync(path.join(dir, 'again', 'golden-diff', '01-board.light.png')));

  const made = [...devicesMade(first.stdout), ...devicesMade(second.stdout)];
  assert.equal(made.length, 4, 'two devices for each capture');
  const left = hostDevices().filter((name) => made.includes(name));
  assert.deepEqual(left, [], 'every device a capture made is deleted');
});
