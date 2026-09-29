// The output plumbing: ffmpeg binary resolution, TTS synthesis, narration-track
// assembly, and the optional music bed. All ffmpeg use funnels through here so both
// capture modes share one encoder path.
//
// Narration is OPTIONAL and best-effort: with no OPENAI_API_KEY, or on ANY synthesis
// failure, every builder collapses to null and the caller keeps a silent video. That
// degradation is the contract — narration can never break the video.

import ffmpegPath from 'ffmpeg-static';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The usable ffmpeg binary, or null when none is provisioned.
 *
 * `ffmpeg-static` delivers its binary through an `install` lifecycle script, and npm ≥12
 * blocks install scripts for packages outside `allowScripts`. On such a host a plain
 * `npm install` leaves the package directory populated (index.js, install.js, types/)
 * while the binary itself is ABSENT — so the binary is a PROVISIONED asset here:
 * `npm run provision:ffmpeg` fetches it on demand.
 *
 * `ffmpeg-static` resolves an `FFMPEG_BIN` override itself at module load, so this
 * covers both the bundled binary and an explicit system ffmpeg.
 */
export function ffmpegBin(): string | null {
  const p = ffmpegPath as unknown as string | null;
  if (!p) return null;
  // A bare command name (FFMPEG_BIN=ffmpeg) is resolved by the OS from PATH, not from
  // the filesystem — only a real path can be existence-checked.
  if (!p.includes('/') && !p.includes(path.sep)) return p;
  return existsSync(p) ? p : null;
}

/** The binary, or a diagnosis of why there isn't one. For the paths that cannot degrade. */
export function requireFfmpeg(): string {
  const bin = ffmpegBin();
  if (!bin) {
    throw new Error(
      'no ffmpeg binary available. `ffmpeg-static` ships it via an install script, which ' +
        'npm ≥12 blocks for packages outside `allowScripts` — run `npm run provision:ffmpeg` ' +
        'to fetch it, or set FFMPEG_BIN to a system ffmpeg.',
    );
  }
  return bin;
}

/** Run ffmpeg with args; stdio captured so its stderr chatter stays out of the run output. */
export function run(args: string[]): string {
  return execFileSync(requireFfmpeg(), args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) ?? '';
}

/**
 * Probe a media file's duration (seconds) from ffmpeg's `Duration:` banner; 0 if
 * unknown. ffmpeg prints the banner to STDERR and `-f null -` exits 0, so this uses
 * spawnSync (which exposes stderr on success) — execFileSync returns stdout only, which
 * is empty here.
 *
 * `bin` is injectable so the stderr-banner behaviour can be pinned against a stub on a
 * host with no ffmpeg. With no binary at all the probe returns 0 — the same "duration
 * unknown" answer a failed probe gives, which callers treat as "fall back to the slot's
 * base duration".
 */
export function probeDuration(file: string, bin: string | null = ffmpegBin()): number {
  if (!bin) return 0;
  const res = spawnSync(bin, ['-i', file, '-hide_banner', '-f', 'null', '-'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = `${res.stderr ?? ''}${res.stdout ?? ''}`;
  const m = out.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

/** One OpenAI TTS clip → mp3 file. Returns false on any failure (caller degrades to silence). Never logs the key. */
export async function ttsClip(text: string, outFile: string, apiKey: string): Promise<boolean> {
  const model = process.env.DEMO_TTS_MODEL || 'tts-1';
  const voice = process.env.DEMO_TTS_VOICE || 'nova';
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, voice, input: text, response_format: 'mp3' }),
    });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return false;
    writeFileSync(outFile, buf);
    return true;
  } catch {
    return false;
  }
}

/** A narration slot: what to say, and the minimum seconds it occupies on screen. */
export interface NarrationSegment {
  narration: string;
  minDuration: number;
}

export interface NarrationTrack {
  /** The assembled narration audio (m4a). */
  audioPath: string;
  /** Per-segment seconds — equal to each `minDuration` unless `stretch` grew it to fit. */
  durations: number[];
}

/**
 * Synthesize a narration track aligned to a list of slots.
 *
 * `stretch` decides how a clip that is longer than its slot is handled:
 *   • true  — the slot GROWS to `max(minDuration, clip + 0.5s)`, so speech is never
 *             clipped. Used by the still-frame path, where a frame can simply be shown
 *             longer. The grown durations come back so the caller can retime the frames.
 *   • false — the slot is FIXED at `minDuration` and the clip is padded or trimmed to
 *             it. Used by the walkthrough path, where the video length is already set
 *             by the recording and the audio must fit it.
 *
 * Returns null — keeping the caller on the silent path — with no key, or the moment any
 * clip fails to synthesize.
 */
export async function buildNarration(
  segments: NarrationSegment[],
  opts: { stretch: boolean },
  tmp: string,
  log: (m: string) => void,
): Promise<NarrationTrack | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  log('narration: OPENAI_API_KEY set — synthesizing per-step narration…');

  const durations: number[] = [];
  const clips: (string | null)[] = [];
  for (let i = 0; i < segments.length; i++) {
    const text = segments[i].narration?.trim();
    const base = segments[i].minDuration;
    if (!text) {
      durations.push(base);
      clips.push(null);
      continue;
    }
    const clip = path.join(tmp, `tts-${String(i).padStart(3, '0')}.mp3`);
    const ok = await ttsClip(text, clip, apiKey);
    if (!ok) {
      log(`narration: clip ${i} failed — reverting to a silent video`);
      return null;
    }
    durations.push(opts.stretch ? Math.max(base, probeDuration(clip) + 0.5) : base);
    clips.push(clip);
  }

  // Pad each clip up to its slot (or generate silence for an empty slot), then concat.
  // `apad=whole_dur` extends a short clip; `-t` trims a long one — so one command both
  // pads and trims to the exact slot length whether stretching or not.
  const padded: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const dur = durations[i].toFixed(3);
    const out = path.join(tmp, `seg-${String(i).padStart(3, '0')}.m4a`);
    if (clips[i]) {
      run(['-y', '-i', clips[i] as string, '-af', `apad=whole_dur=${dur}`, '-t', dur, '-c:a', 'aac', out]);
    } else {
      run(['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', dur, '-c:a', 'aac', out]);
    }
    padded.push(out);
  }
  const listPath = path.join(tmp, 'audio-concat.txt');
  writeFileSync(listPath, padded.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const audioPath = path.join(tmp, 'narration.m4a');
  run(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'aac', audioPath]);
  return { audioPath, durations };
}

/** Stream-copy a video into a clean container at `to`. */
export function copyVideo(from: string, to: string): void {
  run(['-y', '-i', from, '-c', 'copy', to]);
}

/**
 * Write `outputPath` from a silent video plus an optional audio track. With audio, muxes
 * it in (trimmed to the video with `-shortest`); with none — or on a mux failure — copies
 * the silent video through, so a failure in the audio layer never loses the video.
 * Returns whether audio was muxed.
 */
export function muxOrCopy(silentVideo: string, audioPath: string | null, outputPath: string, log: (m: string) => void): boolean {
  if (!audioPath) {
    copyVideo(silentVideo, outputPath);
    return false;
  }
  try {
    run(['-y', '-i', silentVideo, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath]);
    return true;
  } catch (e) {
    log(`mux failed (${(e as Error).message.split('\n')[0]}) — keeping the silent video`);
    copyVideo(silentVideo, outputPath);
    return false;
  }
}

/**
 * Lay an optional music bed under the audio. With a voice track present the music is
 * ducked low and mixed beneath it; with no voice the music becomes the whole bed at a
 * modest level. Loops or trims to `totalDuration`. Returns the mixed path, or — on any
 * failure — the original `voicePath` so the music bed can never break a working audio
 * track. Returns null only when there is nothing to produce (no voice and the mix
 * failed).
 */
export function mixMusicBed(
  voicePath: string | null,
  musicPath: string,
  totalDuration: number,
  tmp: string,
  log: (m: string) => void,
): string | null {
  if (!existsSync(musicPath)) {
    log(`music: file not found (${musicPath}) — skipping the bed`);
    return voicePath;
  }
  const out = path.join(tmp, 'mixed.m4a');
  const dur = totalDuration.toFixed(3);
  try {
    if (voicePath) {
      run([
        '-y',
        '-i', voicePath,
        '-stream_loop', '-1', '-i', musicPath,
        '-filter_complex', '[1:a]volume=0.14[bed];[0:a][bed]amix=inputs=2:duration=first:dropout_transition=0[a]',
        '-map', '[a]', '-t', dur, '-c:a', 'aac', out,
      ]);
    } else {
      run(['-y', '-stream_loop', '-1', '-i', musicPath, '-af', 'volume=0.30', '-t', dur, '-c:a', 'aac', out]);
    }
    return out;
  } catch (e) {
    log(`music: mixing failed (${(e as Error).message.split('\n')[0]}) — keeping the unmixed audio`);
    return voicePath;
  }
}
