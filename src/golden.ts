// Golden images: the screenshots of a run kept in a repository as references, and a later
// run compared with them.
//
// A run is a directory of PNGs, such as `sprintshow screenshot --each-step` or
// `sprintshow simulator` writes, and its golden images are a directory of PNGs with the
// same names, committed beside the code they show. Only the PNGs directly in each
// directory count. An image of the run is compared with the golden image of its name, and
// a name that only one side has is a difference too, so a step a script gained or lost
// shows as one.
//
// Two images match when they are the same size and no more than `maxDiffPixels` of their
// pixels differ. pixelmatch decides whether a pixel differs: its colour has moved further
// than `threshold` (0 to 1, a distance in the OKLab colour space), and the pixel is not
// an anti-aliased edge, whose shade can move between two renderings of one screen. Each
// difference writes a diff image into `golden-diff/` in the run's directory: the golden
// image faded to grey with its differing pixels in red, or, for two images of different
// sizes, the golden image and the run's side by side.
//
// Updating rewrites the golden images from the run: an image the run changed or added is
// written, a golden image the run no longer has is removed, and one that matches is left
// as it is, so a run whose pixels moved within the tolerance changes no committed file.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/** The directory, in a run's directory, that a comparison writes its diff images to. */
export const DIFF_DIR = 'golden-diff';
/** How far a pixel's colour may move, from 0 to 1, before the pixel differs, unless a comparison names another threshold. */
export const DEFAULT_THRESHOLD = 0.1;

export interface GoldenOptions {
  /** The run's directory. Its PNGs are the run's images. */
  runDir: string;
  /** The golden images' directory. A directory that does not exist holds no golden image. */
  goldenDir: string;
  /** How far a pixel's colour may move, from 0 (not at all) to 1, before the pixel differs. Default: DEFAULT_THRESHOLD. */
  threshold?: number;
  /** How many pixels of an image may differ before the image does. Default: 0. */
  maxDiffPixels?: number;
  log?: (m: string) => void;
}

/**
 * How one image of a run stands against its golden image.
 *
 * - `match`: both are the same size and at most maxDiffPixels of their pixels differ.
 * - `differs`: more pixels differ, or the sizes do.
 * - `new`: the run has the image and the golden images do not.
 * - `missing`: a golden image the run does not have.
 */
export type GoldenStatus = 'match' | 'differs' | 'new' | 'missing';

export interface GoldenImage {
  /** The PNG's file name, the same in the run and among the golden images. */
  name: string;
  status: GoldenStatus;
  /** For two images of one size: how many pixels differ. */
  diffPixels?: number;
  /** For two images of different sizes: each one's size, `<width>x<height>`. */
  runSize?: string;
  goldenSize?: string;
  /** The diff image a difference wrote, for `differs` in a comparison. */
  diffPath?: string;
}

export interface GoldenComparison {
  images: GoldenImage[];
  /** How many images are not a `match`. */
  differences: number;
}

export interface GoldenUpdate {
  images: GoldenImage[];
  /** The golden images written: the run's new and changed images. */
  written: string[];
  /** The golden images removed, which the run does not have. */
  removed: string[];
}

/**
 * Make `dir` for a capture's PNGs, and throw, naming `command`, when it is a file or
 * already holds files. A run's directory then holds exactly the images of one run once
 * the capture is done.
 */
export function claimOutputDir(dir: string, command: string): void {
  if (existsSync(dir) && !statSync(dir).isDirectory()) throw new Error(`${command}: ${dir} is a file; name a new or empty directory`);
  mkdirSync(dir, { recursive: true });
  if (readdirSync(dir).length > 0) throw new Error(`${command}: ${dir} already holds files; name a new or empty directory`);
}

/** The PNGs directly in `dir`, by name, or none when it does not exist. */
function pngsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) throw new Error(`golden: ${dir} is not a directory`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.toLowerCase().endsWith('.png'))
    .map((e) => e.name)
    .sort();
}

function readPng(file: string): PNG {
  try {
    return PNG.sync.read(readFileSync(file));
  } catch (e) {
    throw new Error(`golden: cannot read ${file} as a PNG: ${(e as Error).message}`);
  }
}

const sizeOf = (png: PNG): string => `${png.width}x${png.height}`;

/** The two images side by side on grey, the golden one on the left, for a diff of two sizes. */
function sideBySide(golden: PNG, run: PNG): PNG {
  const gap = 16;
  const out = new PNG({ width: golden.width + gap + run.width, height: Math.max(golden.height, run.height) });
  for (let i = 0; i < out.data.length; i += 4) out.data.set([128, 128, 128, 255], i);
  PNG.bitblt(golden, out, 0, 0, golden.width, golden.height, 0, 0);
  PNG.bitblt(run, out, 0, 0, run.width, run.height, golden.width + gap, 0);
  return out;
}

interface Checked {
  images: GoldenImage[];
  /** The diff image of each `differs`, by name, to write in a comparison. */
  diffs: Map<string, PNG>;
}

/** Hold each image of the run against its golden image. Throws when the run's directory holds no PNG, or names the golden images' directory. */
function check(opts: GoldenOptions): Checked {
  const { runDir, goldenDir } = opts;
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const maxDiffPixels = opts.maxDiffPixels ?? 0;
  if (!(threshold >= 0 && threshold <= 1)) throw new Error(`golden: the threshold is a number from 0 to 1 (got ${opts.threshold})`);
  if (!(Number.isInteger(maxDiffPixels) && maxDiffPixels >= 0)) throw new Error(`golden: the pixels that may differ are a whole number, 0 or more (got ${opts.maxDiffPixels})`);
  if (!existsSync(runDir) || !statSync(runDir).isDirectory()) throw new Error(`golden: the run's directory ${runDir} does not exist`);
  if (existsSync(goldenDir) && realpathSync(goldenDir) === realpathSync(runDir)) throw new Error('golden: the run and the golden images are one directory; name two');
  const run = new Set(pngsIn(runDir));
  if (run.size === 0) throw new Error(`golden: ${runDir} holds no PNG to compare`);
  const golden = new Set(pngsIn(goldenDir));

  const images: GoldenImage[] = [];
  const diffs = new Map<string, PNG>();
  for (const name of [...new Set([...run, ...golden])].sort()) {
    if (!golden.has(name)) {
      images.push({ name, status: 'new' });
      continue;
    }
    if (!run.has(name)) {
      images.push({ name, status: 'missing' });
      continue;
    }
    const [a, b] = [readPng(path.join(goldenDir, name)), readPng(path.join(runDir, name))];
    if (a.width !== b.width || a.height !== b.height) {
      images.push({ name, status: 'differs', runSize: sizeOf(b), goldenSize: sizeOf(a) });
      diffs.set(name, sideBySide(a, b));
      continue;
    }
    const diff = new PNG({ width: a.width, height: a.height });
    const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
    const status: GoldenStatus = diffPixels > maxDiffPixels ? 'differs' : 'match';
    images.push({ name, status, diffPixels });
    if (status === 'differs') diffs.set(name, diff);
  }
  return { images, diffs };
}

const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** What a difference amounts to, for the log. */
function howItDiffers(image: GoldenImage): string {
  if (image.status === 'new') return 'no golden image has its name';
  if (image.status === 'missing') return 'the run has no image of its name';
  if (image.runSize) return `the run's is ${image.runSize}, the golden one ${image.goldenSize}`;
  return `${count(image.diffPixels ?? 0, 'pixel')} differ${image.diffPixels === 1 ? 's' : ''}`;
}

/**
 * Compare a run's images with the golden images, writing a diff image into the run's
 * `golden-diff/` for each pair that differs. The diff images of an earlier comparison of
 * the run are removed first. Throws when the run's directory does not exist or holds no
 * PNG, the two directories are one, or a PNG cannot be read.
 */
export function compareGolden(opts: GoldenOptions): GoldenComparison {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { images, diffs } = check(opts);
  const diffDir = path.join(opts.runDir, DIFF_DIR);
  rmSync(diffDir, { recursive: true, force: true });
  log(`golden: comparing ${count(images.filter((i) => i.status !== 'missing').length, 'image')} of ${opts.runDir} with the golden images in ${opts.goldenDir}`);
  for (const image of images) {
    const diff = diffs.get(image.name);
    if (diff) {
      mkdirSync(diffDir, { recursive: true });
      image.diffPath = path.join(diffDir, image.name);
      writeFileSync(image.diffPath, PNG.sync.write(diff));
    }
    if (image.status === 'match') log(`  ✓ ${image.name}`);
    else log(`  ✗ ${image.name}: ${howItDiffers(image)}${image.diffPath ? ` → ${image.diffPath}` : ''}`);
  }
  const differences = images.filter((i) => i.status !== 'match').length;
  log(differences === 0 ? `golden: every image matches its golden image` : `golden: ${count(differences, 'image')} differ${differences === 1 ? 's' : ''} from the golden images; --update rewrites them from this run`);
  return { images, differences };
}

/**
 * Rewrite the golden images from a run: write each image the run changed or added, remove
 * each golden image the run does not have, and leave each match as it is. Creates the
 * golden images' directory when it does not exist. Throws as compareGolden does.
 */
export function updateGolden(opts: GoldenOptions): GoldenUpdate {
  const log = opts.log ?? ((m: string) => console.log(m));
  const { images } = check(opts);
  const written: string[] = [];
  const removed: string[] = [];
  log(`golden: updating the golden images in ${opts.goldenDir} from ${opts.runDir}`);
  mkdirSync(opts.goldenDir, { recursive: true });
  for (const image of images) {
    const golden = path.join(opts.goldenDir, image.name);
    if (image.status === 'match') {
      log(`  ✓ ${image.name}: unchanged`);
    } else if (image.status === 'missing') {
      rmSync(golden);
      removed.push(golden);
      log(`  − ${image.name}: removed, the run has no image of its name`);
    } else {
      copyFileSync(path.join(opts.runDir, image.name), golden);
      written.push(golden);
      log(`  + ${image.name}: ${image.status === 'new' ? 'written' : `rewritten, ${howItDiffers(image)}`}`);
    }
  }
  log(`golden: ${count(written.length, 'image')} written, ${count(removed.length, 'image')} removed, ${count(images.length - written.length - removed.length, 'image')} unchanged`);
  return { images, written, removed };
}
