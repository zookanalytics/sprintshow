// Tests for the timing helpers: baseDuration (src/assemble.ts) and probeDuration
// (src/ffmpeg.ts), and for how assembleVideo lays out frames of more than one size.
//
// probeDuration is pinned against ffmpeg's real output shape: ffmpeg prints its
// `Duration:` banner to STDERR, so a stdout-only read returns 0 and narration is silently
// truncated to the frame's base duration. These tests fail on that bug.
//
// The regression is pinned twice: against a STUB ffmpeg that reproduces the stdout/stderr
// split exactly (hermetic, runs on every host) and against the REAL binary when one is
// provisioned. The real-binary tests skip cleanly with no binary — npm ≥12 blocks
// `ffmpeg-static`'s install script, so a plain `npm install` yields a populated package
// directory with no binary until `npm run provision:ffmpeg` fetches it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { assembleVideo, baseDuration, type Frame } from '../src/assemble.ts';
import { ffmpegBin, probeDuration } from '../src/ffmpeg.ts';

const frame = (over: Partial<Frame>): Frame => ({
  file: '01-x.png',
  narration: 'x',
  duration: 3.5,
  observation: null,
  proof: 'passed',
  severity: null,
  ...over,
});

/** Skip reason for the tests that need a real ffmpeg, or false when one is provisioned. */
const needsFfmpeg = ffmpegBin()
  ? false
  : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

/**
 * A stand-in ffmpeg writing a fixed stdout/stderr split, which is the only thing
 * probeDuration reads. Node (not sh) so the payloads embed as JSON with no quoting
 * hazard. Returns the executable's path.
 */
function stubFfmpeg(dir: string, out: { stdout?: string; stderr?: string; code?: number }): string {
  const p = path.join(dir, 'ffmpeg-stub.mjs');
  writeFileSync(
    p,
    `#!/usr/bin/env node\n` +
      `process.stdout.write(${JSON.stringify(out.stdout ?? '')});\n` +
      `process.stderr.write(${JSON.stringify(out.stderr ?? '')});\n` +
      `process.exit(${out.code ?? 0});\n`,
    { mode: 0o755 },
  );
  return p;
}

/** Run `fn` with a scratch dir that is always cleaned up. */
function withTmp<T>(fn: (dir: string) => T): T {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-test-'));
  try {
    return fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('baseDuration: duration as-is, +1s with an observation, 3.5s fallback', () => {
  assert.equal(baseDuration(frame({})), 3.5);
  assert.equal(baseDuration(frame({ duration: 5 })), 5);
  assert.equal(baseDuration(frame({ observation: 'proof failed' })), 4.5);
  assert.equal(baseDuration(frame({ duration: NaN })), 3.5);
  assert.equal(baseDuration(frame({ duration: 0 })), 3.5);
});

test('probeDuration reads the Duration banner from STDERR, not stdout', () => {
  withTmp((tmp) => {
    const bin = stubFfmpeg(tmp, {
      stdout: 'stdout carries no Duration\n',
      stderr: "Input #0, mov,mp4,m4a, from 'tone.m4a':\n  Duration: 00:00:01.20, start: 0.000000, bitrate: 2 kb/s\n",
    });
    assert.equal(probeDuration('/any/clip.m4a', bin), 1.2);
  });
});

test('probeDuration parses hours, minutes and seconds out of the banner', () => {
  withTmp((tmp) => {
    const bin = stubFfmpeg(tmp, { stderr: '  Duration: 01:02:03.50, start: 0.000000\n' });
    assert.equal(probeDuration('/any/clip.m4a', bin), 3723.5);
  });
});

test('probeDuration: 0 when the probe emits no Duration banner', () => {
  withTmp((tmp) => {
    const bin = stubFfmpeg(tmp, { stderr: 'nothing.mp3: No such file or directory\n', code: 1 });
    assert.equal(probeDuration('/nonexistent/nothing.mp3', bin), 0);
  });
});

test('probeDuration: 0 when no ffmpeg is provisioned', () => {
  assert.equal(probeDuration('/any/clip.m4a', null), 0);
});

test('probeDuration reads the real duration of a successful probe (stderr banner)', { skip: needsFfmpeg }, () => {
  withTmp((tmp) => {
    const clip = path.join(tmp, 'tone.m4a');
    execFileSync(ffmpegBin() as string, ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1.2', '-c:a', 'aac', clip], { stdio: ['ignore', 'pipe', 'pipe'] });
    const d = probeDuration(clip);
    assert.ok(d > 1.0 && d < 1.5, `expected ~1.2s, got ${d}`);
  });
});

test('probeDuration: 0 for a file that is not media', { skip: needsFfmpeg }, () => {
  assert.equal(probeDuration('/nonexistent/nothing.mp3'), 0);
});

/** The RGB of the pixel at (x, y) in the frame of `video` shown `t` seconds in. */
function pixelAt(video: string, t: number, x: number, y: number): number[] {
  const out = execFileSync(ffmpegBin() as string, ['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'pipe'] });
  return [...out.subarray(0, 3)];
}

test('frames of more than one size make a video the size of the largest, each smaller frame at its top-left corner on gray', { skip: needsFfmpeg }, async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-test-'));
  try {
    // A phone's frame, 375x812, then a desktop's, 1280x800: wider, and not as tall.
    const still = (file: string, color: string, size: string): void => {
      execFileSync(ffmpegBin() as string, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size},format=rgb24`, '-frames:v', '1', path.join(tmp, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    };
    still('01-phone.png', 'red', '375x812');
    still('02-desktop.png', 'blue', '1280x800');
    writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({ title: 'Two sizes', frames: [frame({ file: '01-phone.png', duration: 1 }), frame({ file: '02-desktop.png', duration: 1 })] }));
    const video = path.join(tmp, 'out.mp4');
    await assembleVideo({ capturesDir: tmp, outputPath: video, noNarrate: true, log: () => {} });

    const banner = spawnSync(ffmpegBin() as string, ['-hide_banner', '-i', video], { encoding: 'utf8' }).stderr;
    assert.match(banner, /Video: h264 .*, 1280x812[ ,]/, 'the video is as wide as the desktop frame and as tall as the phone frame');
    assert.match(banner, /SAR 1:1/, 'no frame is squeezed into another size');
    const near = (got: number[], want: number[]): boolean => got.every((c, i) => Math.abs(c - want[i]) <= 16);
    const [red, gray, blue] = [[255, 0, 0], [128, 128, 128], [0, 0, 255]];
    for (const [t, x, y, want, where] of [
      [0.5, 100, 400, red, 'the phone frame, at the top-left'],
      [0.5, 370, 805, red, "the phone frame's bottom-right corner"],
      [0.5, 800, 400, gray, 'right of the phone frame'],
      [1.5, 1270, 400, blue, 'the desktop frame, across the whole width'],
      [1.5, 640, 808, gray, 'below the desktop frame'],
    ] as const) {
      const got = pixelAt(video, t, x, y);
      assert.ok(near(got, [...want]), `${where} at ${t}s (${x}, ${y}) is rgb(${got.join(', ')})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
