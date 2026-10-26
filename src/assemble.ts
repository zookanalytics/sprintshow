// Still-frame assembly — the output half of the proof path, and the `assemble`
// entrypoint the agent/MCP-driven flow calls directly.
//
// Turns captured proof frames (NN-*.png) + manifest.json into an MP4: a plain concat +
// libx264 pass, optionally narrated and scored. Captions are already burned into each
// frame as a DOM overlay by the driver (crisp text in the app's own font), so no
// `drawtext`/freetype is needed here. The video is the size of the largest frame, and a
// smaller frame sits at its top-left corner on gray, as a recording draws a viewport
// smaller than its frame.
//
// The silent video is the contract; narration and music are add-ons layered over it,
// and any failure in either keeps the silent cut.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireFfmpeg, run, buildNarration, mixMusicBed, muxOrCopy, type NarrationTrack } from './ffmpeg.ts';

export interface Frame {
  file: string;
  narration: string;
  duration: number;
  observation: string | null;
  proof: 'passed' | 'adapted' | 'failed';
  severity: 'warning' | 'error' | null;
}

export interface Manifest {
  title: string;
  frames: Frame[];
  /** The script's `## Scrutiny` items, when it had any. Carried for the reader; not used for assembly. */
  scrutiny?: string[];
}

export interface AssembleOptions {
  /** Directory holding the NN-*.png frames + manifest.json. */
  capturesDir: string;
  /** Final mp4 path. */
  outputPath: string;
  /** Force silent even when OPENAI_API_KEY is set. */
  noNarrate?: boolean;
  /** Optional music bed mixed under the narration (or on its own). */
  musicPath?: string | null;
  /** Progress sink (defaults to console.log). */
  log?: (m: string) => void;
}

export interface AssembleResult {
  outputPath: string;
  narrated: boolean;
  music: boolean;
}

/** Base seconds a frame is shown before any narration stretch: its duration, +1s if it carries an observation. */
export function baseDuration(f: Frame): number {
  const d = Number.isFinite(f.duration) && f.duration > 0 ? f.duration : 3.5;
  return d + (f.observation ? 1 : 0);
}

/** Write the concat-demuxer list; the last file is repeated with no duration (ffmpeg concat truncates the final frame otherwise). */
function writeConcat(listPath: string, frames: { abs: string; duration: number }[]): void {
  const lines: string[] = [];
  for (const f of frames) {
    lines.push(`file '${f.abs.replace(/'/g, "'\\''")}'`);
    lines.push(`duration ${f.duration.toFixed(3)}`);
  }
  const last = frames[frames.length - 1];
  if (last) lines.push(`file '${last.abs.replace(/'/g, "'\\''")}'`);
  writeFileSync(listPath, lines.join('\n') + '\n');
}

/** Width and height from a PNG's header, or null for a file that is not a PNG. */
function pngSize(file: string): { width: number; height: number } | null {
  const head = Buffer.alloc(24);
  const fd = openSync(file, 'r');
  try {
    readSync(fd, head, 0, head.length, 0);
  } finally {
    closeSync(fd);
  }
  return head.toString('latin1', 1, 4) === 'PNG' && head.toString('latin1', 12, 16) === 'IHDR' ? { width: head.readUInt32BE(16), height: head.readUInt32BE(20) } : null;
}

/**
 * The frames `files` names, each as large as the largest: as wide as the widest and as tall
 * as the tallest. A smaller frame, such as one a script took before it resized its
 * viewport, is copied into `tmp` with gray added along its right and bottom edges. ffmpeg
 * encodes a concat whose frames change size at the first frame's size, squeezing each
 * later frame into it. The sizes are read from the PNG headers, and when a frame is not a
 * PNG, the frames are taken as they are.
 */
function framesOfOneSize(files: string[], tmp: string): string[] {
  const sizes = files.map(pngSize);
  if (sizes.some((s) => s === null)) return files;
  const known = sizes as { width: number; height: number }[];
  const width = Math.max(...known.map((s) => s.width));
  const height = Math.max(...known.map((s) => s.height));
  return files.map((file, i) => {
    if (known[i].width === width && known[i].height === height) return file;
    const padded = path.join(tmp, `frame-${i}.png`);
    run(['-y', '-i', file, '-vf', `pad=${width}:${height}:0:0:color=gray`, padded]);
    return padded;
  });
}

/**
 * Assemble the captured frames into an MP4 at `outputPath`. Encodes the silent video
 * first, then muxes narration and/or a music bed over it when available; any failure in
 * that layer falls back to the silent cut.
 */
export async function assembleVideo(opts: AssembleOptions): Promise<AssembleResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  requireFfmpeg(); // fail early with the provisioning hint, before a browser or a temp dir
  const manifestPath = path.join(opts.capturesDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  if (!manifest.frames?.length) throw new Error(`assemble: manifest has no frames (${manifestPath})`);

  for (const f of manifest.frames) {
    const abs = path.join(opts.capturesDir, f.file);
    if (!existsSync(abs)) throw new Error(`assemble: missing frame ${abs}`);
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-'));
  try {
    // Narration first — it may stretch per-frame durations to fit speech.
    let durations = manifest.frames.map(baseDuration);
    let narration: NarrationTrack | null = null;
    if (!opts.noNarrate) {
      narration = await buildNarration(
        manifest.frames.map((f) => ({ narration: f.narration, minDuration: baseDuration(f) })),
        { stretch: true },
        tmp,
        log,
      );
      if (narration) durations = narration.durations;
    }

    const files = framesOfOneSize(manifest.frames.map((f) => path.join(opts.capturesDir, f.file)), tmp);
    const concatList = path.join(tmp, 'frames.txt');
    writeConcat(
      concatList,
      files.map((abs, i) => ({ abs, duration: durations[i] })),
    );

    // Even dimensions (yuv420p/libx264 require them) + a constant 30fps still track.
    const vf = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30,format=yuv420p';
    const silent = path.join(tmp, 'silent.mp4');
    log(`assemble: encoding ${manifest.frames.length} frames → ${path.basename(opts.outputPath)}`);
    run(['-y', '-f', 'concat', '-safe', '0', '-i', concatList, '-vf', vf, '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-an', silent]);

    // Resolve the audio track: narration, then an optional music bed under it.
    const total = durations.reduce((a, b) => a + b, 0);
    let audioPath = narration?.audioPath ?? null;
    let music = false;
    if (opts.musicPath) {
      const mixed = mixMusicBed(audioPath, opts.musicPath, total, tmp, log);
      music = mixed !== null && mixed !== audioPath;
      audioPath = mixed;
    }

    const muxed = muxOrCopy(silent, audioPath, opts.outputPath, log);
    if (muxed) log(`assemble: muxed ${narration ? 'narration' : 'audio'}${music ? ' + music bed' : ''}`);
    return { outputPath: opts.outputPath, narrated: muxed && Boolean(narration), music: muxed && music };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
