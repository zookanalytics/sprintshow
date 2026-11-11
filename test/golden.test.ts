// Tests for golden images (src/golden.ts) and the `sprintshow golden` command over them.
//
// A run's PNGs are compared by name with the golden images. Two images match when they are
// the same size and no more of their pixels differ than the comparison allows, a pixel
// differing when its colour moves past the threshold. A difference writes a diff image into
// the run's golden-diff/, and a name only one side has is a difference too. Updating
// writes the run's new and changed images, removes the golden images the run lacks, and
// leaves the matches as committed. The command exits 0 when every image matches or the
// update is written, 3 when an image differs, and 1 when nothing could be compared.
//
// The images are made here with pngjs, so these tests need no browser and no simulator.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import { compareGolden, updateGolden, DIFF_DIR } from '../src/golden.ts';
import { scratchDir, runCli } from './browser-fixture.ts';

const quiet = (): void => {};

type Rgba = [number, number, number, number];

/** A PNG of `width` by `height` pixels of `fill`, with each of `spots` painted its own colour. */
function png(width: number, height: number, fill: Rgba, spots: { x: number; y: number; rgba: Rgba }[] = []): Buffer {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) img.data.set(fill, i);
  for (const { x, y, rgba } of spots) img.data.set(rgba, (y * width + x) * 4);
  return PNG.sync.write(img);
}

/** The RGBA of a PNG file's pixel at (x, y). */
function pixel(file: string, x: number, y: number): number[] {
  const img = PNG.sync.read(readFileSync(file));
  return [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
}

const WHITE: Rgba = [255, 255, 255, 255];
const BLACK: Rgba = [0, 0, 0, 255];

/** A run's directory and a golden directory under one scratch directory, each holding the named PNGs. */
function dirs(run: Record<string, Buffer>, golden: Record<string, Buffer> | null): { runDir: string; goldenDir: string; cleanup(): void } {
  const { dir, cleanup } = scratchDir();
  const runDir = path.join(dir, 'run');
  const goldenDir = path.join(dir, 'golden');
  mkdirSync(runDir);
  for (const [name, body] of Object.entries(run)) writeFileSync(path.join(runDir, name), body);
  if (golden) {
    mkdirSync(goldenDir);
    for (const [name, body] of Object.entries(golden)) writeFileSync(path.join(goldenDir, name), body);
  }
  return { runDir, goldenDir, cleanup };
}

describe('compareGolden', () => {
  test('a run whose images are the golden ones matches, and writes no diff image', (t) => {
    const d = dirs({ 'a.png': png(20, 10, WHITE), 'b.png': png(20, 10, BLACK) }, { 'a.png': png(20, 10, WHITE), 'b.png': png(20, 10, BLACK) });
    t.after(d.cleanup);
    const lines: string[] = [];
    const res = compareGolden({ ...d, log: (m) => lines.push(m) });
    assert.equal(res.differences, 0);
    assert.deepEqual(
      res.images.map((i) => [i.name, i.status, i.diffPixels]),
      [
        ['a.png', 'match', 0],
        ['b.png', 'match', 0],
      ],
    );
    assert.ok(!existsSync(path.join(d.runDir, DIFF_DIR)), 'a match writes no diff image');
    assert.ok(lines.includes('  ✓ a.png') && lines.includes('  ✓ b.png'), lines.join('\n'));
  });

  test('a pixel that moved writes a diff image that marks it in red over the faded golden image', (t) => {
    const d = dirs({ 'a.png': png(20, 10, WHITE, [{ x: 7, y: 3, rgba: BLACK }]) }, { 'a.png': png(20, 10, WHITE) });
    t.after(d.cleanup);
    const lines: string[] = [];
    const res = compareGolden({ ...d, log: (m) => lines.push(m) });
    assert.equal(res.differences, 1);
    const [image] = res.images;
    assert.equal(image.status, 'differs');
    assert.equal(image.diffPixels, 1);
    assert.equal(image.diffPath, path.join(d.runDir, DIFF_DIR, 'a.png'));
    assert.deepEqual(pixel(image.diffPath, 7, 3), [255, 0, 0, 255], 'the differing pixel is red');
    const [r, g, b] = pixel(image.diffPath, 0, 0);
    assert.ok(r === g && g === b && r > 200, `an unchanged pixel is the golden image, faded to grey (got ${r},${g},${b})`);
    assert.ok(lines.some((l) => l.startsWith('  ✗ a.png: 1 pixel differs → ')), lines.join('\n'));
  });

  test('the differing pixels an image may have before it differs are maxDiffPixels', (t) => {
    const two = png(20, 10, WHITE, [
      { x: 1, y: 1, rgba: BLACK },
      { x: 5, y: 5, rgba: BLACK },
    ]);
    const d = dirs({ 'a.png': two }, { 'a.png': png(20, 10, WHITE) });
    t.after(d.cleanup);
    assert.equal(compareGolden({ ...d, maxDiffPixels: 2, log: quiet }).differences, 0);
    assert.equal(compareGolden({ ...d, maxDiffPixels: 1, log: quiet }).differences, 1);
  });

  test('a colour that moves less than the threshold does not make a pixel differ', (t) => {
    const near: Rgba = [250, 250, 250, 255];
    const d = dirs({ 'a.png': png(20, 10, WHITE, [{ x: 4, y: 4, rgba: near }]) }, { 'a.png': png(20, 10, WHITE) });
    t.after(d.cleanup);
    assert.equal(compareGolden({ ...d, log: quiet }).differences, 0, 'within the default threshold');
    assert.equal(compareGolden({ ...d, threshold: 0, log: quiet }).differences, 1, 'a threshold of 0 takes any move');
  });

  test('two images of different sizes differ, and the diff image shows them side by side', (t) => {
    const d = dirs({ 'a.png': png(30, 12, BLACK) }, { 'a.png': png(20, 10, WHITE) });
    t.after(d.cleanup);
    const lines: string[] = [];
    const [image] = compareGolden({ ...d, log: (m) => lines.push(m) }).images;
    assert.equal(image.status, 'differs');
    assert.equal(image.runSize, '30x12');
    assert.equal(image.goldenSize, '20x10');
    const diff = PNG.sync.read(readFileSync(image.diffPath as string));
    assert.deepEqual([diff.width, diff.height], [20 + 16 + 30, 12]);
    assert.deepEqual(pixel(image.diffPath as string, 0, 0), WHITE, 'the golden image on the left');
    assert.deepEqual(pixel(image.diffPath as string, 36, 0), BLACK, "the run's on the right");
    assert.ok(lines.some((l) => l.includes("a.png: the run's is 30x12, the golden one 20x10")), lines.join('\n'));
  });

  test('an image only the run has, and a golden image the run lacks, are differences', (t) => {
    const d = dirs({ 'a.png': png(4, 4, WHITE), 'new.png': png(4, 4, WHITE) }, { 'a.png': png(4, 4, WHITE), 'gone.png': png(4, 4, WHITE) });
    t.after(d.cleanup);
    const lines: string[] = [];
    const res = compareGolden({ ...d, log: (m) => lines.push(m) });
    assert.deepEqual(
      res.images.map((i) => [i.name, i.status]),
      [
        ['a.png', 'match'],
        ['gone.png', 'missing'],
        ['new.png', 'new'],
      ],
    );
    assert.equal(res.differences, 2);
    assert.ok(lines.includes('  ✗ new.png: no golden image has its name'), lines.join('\n'));
    assert.ok(lines.includes('  ✗ gone.png: the run has no image of its name'), lines.join('\n'));
  });

  test('golden images that do not exist yet leave every image of the run new', (t) => {
    const d = dirs({ 'a.png': png(4, 4, WHITE) }, null);
    t.after(d.cleanup);
    const res = compareGolden({ ...d, log: quiet });
    assert.deepEqual(
      res.images.map((i) => i.status),
      ['new'],
    );
  });

  test('only the PNGs directly in each directory count, and a later comparison replaces the diff images', (t) => {
    const d = dirs({ 'a.png': png(4, 4, BLACK), 'notes.txt': Buffer.from('x') }, { 'a.png': png(4, 4, WHITE), 'README.md': Buffer.from('x') });
    t.after(d.cleanup);
    mkdirSync(path.join(d.runDir, 'nested'));
    writeFileSync(path.join(d.runDir, 'nested', 'b.png'), png(4, 4, WHITE));
    assert.deepEqual(
      compareGolden({ ...d, log: quiet }).images.map((i) => i.name),
      ['a.png'],
    );
    assert.deepEqual(readdirSync(path.join(d.runDir, DIFF_DIR)), ['a.png']);
    writeFileSync(path.join(d.runDir, 'a.png'), png(4, 4, WHITE));
    assert.equal(compareGolden({ ...d, log: quiet }).differences, 0);
    assert.ok(!existsSync(path.join(d.runDir, DIFF_DIR)), "the earlier comparison's diff image is gone");
  });

  test('a run that cannot be compared throws', (t) => {
    const d = dirs({}, { 'a.png': png(4, 4, WHITE) });
    t.after(d.cleanup);
    assert.throws(() => compareGolden({ ...d, log: quiet }), /holds no PNG to compare/);
    assert.throws(() => compareGolden({ runDir: path.join(d.runDir, 'absent'), goldenDir: d.goldenDir, log: quiet }), /does not exist/);
    assert.throws(() => compareGolden({ runDir: d.goldenDir, goldenDir: d.goldenDir, log: quiet }), /one directory/);
    writeFileSync(path.join(d.runDir, 'a.png'), 'not a png');
    assert.throws(() => compareGolden({ ...d, log: quiet }), /cannot read .*a\.png as a PNG/);
    writeFileSync(path.join(d.runDir, 'a.png'), png(4, 4, WHITE));
    assert.throws(() => compareGolden({ ...d, threshold: 2, log: quiet }), /threshold is a number from 0 to 1/);
    assert.throws(() => compareGolden({ ...d, maxDiffPixels: -1, log: quiet }), /whole number/);
  });
});

describe('updateGolden', () => {
  test('writes the new and changed images, removes the ones the run lacks, and leaves a match as committed', (t) => {
    // The run's b.png moved within the threshold and is encoded differently, so its bytes
    // differ while it still matches: the committed file stays.
    const committedB = png(4, 4, WHITE);
    const d = dirs(
      { 'a.png': png(4, 4, BLACK), 'b.png': png(4, 4, WHITE, [{ x: 0, y: 0, rgba: [252, 252, 252, 255] }]), 'c.png': png(4, 4, WHITE) },
      { 'a.png': png(4, 4, WHITE), 'b.png': committedB, 'gone.png': png(4, 4, WHITE) },
    );
    t.after(d.cleanup);
    const lines: string[] = [];
    const res = updateGolden({ ...d, log: (m) => lines.push(m) });
    assert.deepEqual(res.written, [path.join(d.goldenDir, 'a.png'), path.join(d.goldenDir, 'c.png')]);
    assert.deepEqual(res.removed, [path.join(d.goldenDir, 'gone.png')]);
    assert.deepEqual(readdirSync(d.goldenDir).sort(), ['a.png', 'b.png', 'c.png']);
    assert.deepEqual(readFileSync(path.join(d.goldenDir, 'a.png')), readFileSync(path.join(d.runDir, 'a.png')));
    assert.deepEqual(readFileSync(path.join(d.goldenDir, 'b.png')), committedB, 'a match is left as committed');
    assert.ok(lines.includes('  + c.png: written'), lines.join('\n'));
    assert.ok(lines.includes('  + a.png: rewritten, 16 pixels differ'), lines.join('\n'));
    assert.ok(lines.includes('  − gone.png: removed, the run has no image of its name'), lines.join('\n'));
    assert.equal(compareGolden({ ...d, log: quiet }).differences, 0, 'the run matches the golden images it wrote');
  });

  test('creates the golden directory', (t) => {
    const d = dirs({ 'a.png': png(4, 4, WHITE) }, null);
    t.after(d.cleanup);
    updateGolden({ ...d, log: quiet });
    assert.ok(statSync(path.join(d.goldenDir, 'a.png')).isFile());
  });
});

describe('sprintshow golden', () => {
  test('exits 0 when every image matches, 3 when one differs, and 1 when nothing is compared', async (t) => {
    const d = dirs({ 'a.png': png(4, 4, WHITE) }, { 'a.png': png(4, 4, WHITE) });
    t.after(d.cleanup);
    const same = await runCli(['golden', d.runDir, d.goldenDir]);
    assert.equal(same.code, 0, same.stdout + same.stderr);
    assert.match(same.stdout, /✅ every image matches its golden image/);

    writeFileSync(path.join(d.runDir, 'a.png'), png(4, 4, BLACK));
    const differs = await runCli(['golden', d.runDir, d.goldenDir]);
    assert.equal(differs.code, 3, differs.stdout + differs.stderr);
    assert.match(differs.stdout, /❌ 1 image\(s\) differ from the golden images — the diff images are in /);
    assert.ok(existsSync(path.join(d.runDir, DIFF_DIR, 'a.png')));

    const allowed = await runCli(['golden', d.runDir, d.goldenDir, '--max-diff-pixels', '16']);
    assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);

    const none = await runCli(['golden', path.join(d.runDir, 'absent'), d.goldenDir]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /does not exist/);

    const usage = await runCli(['golden', d.runDir]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /a run's directory and the golden images' directory are required/);
  });

  test('a run that only gains or loses an image names no diff images', async (t) => {
    const d = dirs({ 'a.png': png(4, 4, WHITE), 'new.png': png(4, 4, WHITE) }, { 'a.png': png(4, 4, WHITE) });
    t.after(d.cleanup);
    const res = await runCli(['golden', d.runDir, d.goldenDir]);
    assert.equal(res.code, 3, res.stdout + res.stderr);
    assert.match(res.stdout, /❌ 1 image\(s\) differ from the golden images\n/);
  });

  test('--update rewrites the golden images, and the run then matches them', async (t) => {
    const d = dirs({ 'a.png': png(4, 4, BLACK) }, { 'a.png': png(4, 4, WHITE), 'gone.png': png(4, 4, WHITE) });
    t.after(d.cleanup);
    const up = await runCli(['golden', d.runDir, d.goldenDir, '--update']);
    assert.equal(up.code, 0, up.stdout + up.stderr);
    assert.match(up.stdout, /✅ golden images updated → .* \(1 written, 1 removed\)/);
    assert.equal((await runCli(['golden', d.runDir, d.goldenDir])).code, 0);
  });
});
