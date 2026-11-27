// Tests for buildNarration (src/ffmpeg.ts): a clip ffmpeg cannot decode keeps the caller on
// the silent path, as a clip that fails to download does.
//
// The speech service is stubbed: fetch answers each request to api.openai.com with a clip
// chosen by the text it voices, so no real synthesis is asked for. A clip that is audio is
// a tone ffmpeg makes. A clip that is not audio is a sign-in page served with status 200,
// as a proxy serves one. Each test builds the track both ways a capture asks for one: with
// the slots stretched to fit their clips, as the still-frame path does, and with them
// fixed, as the walkthrough does. The tests need a real ffmpeg, and skip without one (see
// assemble.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildNarration, ffmpegBin, type NarrationSegment, type NarrationTrack } from '../src/ffmpeg.ts';

const needsFfmpeg = ffmpegBin() ? false : "ffmpeg un-provisioned (npm ≥12 blocks ffmpeg-static's install script) — `npm run provision:ffmpeg`";

/** A spoken slot, an empty one, and a second spoken slot. */
const SEGMENTS: NarrationSegment[] = [
  { narration: 'First', minDuration: 1 },
  { narration: '', minDuration: 0.5 },
  { narration: 'Second', minDuration: 1 },
];

/**
 * Build the track for SEGMENTS in a scratch dir, with the speech service voicing each text
 * as a tone, or as a page for a text in `pages`. Resolves with the track and the log lines.
 */
async function narrate(stretch: boolean, pages: string[]): Promise<{ track: NarrationTrack | null; logs: string[] }> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'sprintshow-narration-'));
  const tone = path.join(tmp, 'tone.mp3');
  execFileSync(ffmpegBin() as string, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=24000:duration=0.4', '-c:a', 'libmp3lame', tone], { stdio: ['ignore', 'pipe', 'pipe'] });
  const audio = new Uint8Array(readFileSync(tone));
  const realFetch = globalThis.fetch;
  const realKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.openai.com/')) return realFetch(input, init);
    const text = JSON.parse(String(init?.body)).input as string;
    return pages.includes(text)
      ? new Response('<!doctype html><html><body>Sign in to continue</body></html>', { status: 200, headers: { 'Content-Type': 'text/html' } })
      : new Response(audio, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  }) as typeof fetch;
  process.env.OPENAI_API_KEY = 'stub';
  const logs: string[] = [];
  try {
    return { track: await buildNarration(SEGMENTS, { stretch }, tmp, (m) => logs.push(m)), logs };
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = realKey;
    rmSync(tmp, { recursive: true, force: true });
  }
}

test('clips that are all audio make a track of the slots', { skip: needsFfmpeg }, async () => {
  for (const stretch of [true, false]) {
    const { track, logs } = await narrate(stretch, []);
    assert.deepEqual(track?.durations, [1, 0.5, 1], `stretch: ${stretch}`);
    assert.deepEqual(logs, ['narration: OPENAI_API_KEY set — synthesizing per-step narration…'], `stretch: ${stretch}`);
  }
});

test('a clip that is not audio makes no track, and the log names the clip', { skip: needsFfmpeg }, async () => {
  for (const stretch of [true, false]) {
    const { track, logs } = await narrate(stretch, ['Second']);
    assert.equal(track, null, `stretch: ${stretch}`);
    assert.equal(logs.length, 2, `stretch: ${stretch}: ${logs.join(' | ')}`);
    assert.match(logs[1], /^narration: clip 2 failed \(Command failed: .*\/tts-002\.mp3 .*\) — reverting to a silent video$/, `stretch: ${stretch}`);
  }
});
