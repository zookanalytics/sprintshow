# sprintshow

Give an AI agent a way to *show* the work it just did. At the end of a unit of work,
`sprintshow` turns a short markdown script into a quick, **unpolished** demo video — the
agent equivalent of a sprint demo or demo day, not glossy marketing or a social clip.

Over [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp), which drives a
browser, `sprintshow` adds the produced-video layer: a demo-script DSL and linter,
on-screen step captions, an optional TTS voiceover, and ffmpeg assembly into an MP4.

```bash
# produce a narrated, captioned mp4 from the bundled sample, with no app of your own
npx @zookanalytics/sprintshow run demos/sample.md --serve-dir examples/sample-app
```

## What it does

A demo script is markdown that reads as a human walkthrough and carries machine-checkable
directives, so the *same file* documents the demo and drives it. Each step can assert
something against the live page (`visible`, `count`, `text`, …), so what the video shows
is verified behaviour rather than a screen tour — demos are for communicating to people,
and the checks keep them honest.

Two capture modes come out of one script:

- **walkthrough** (default) — one continuous recorded take, driven at a human pace with a
  synthetic cursor and live on-screen captions. The watchable, library/marketing cut.
- **proof** — one screenshot per step, each with its assertion checked and its caption
  burned in. Deterministic and frame-exact; the shape an agent produces when it drives the
  browser itself.

## Install

```bash
npm install -D @zookanalytics/sprintshow
```

Prerequisites, fetched on demand rather than assumed:

- **Node ≥ 22.18** — runs the engine, and the tests via native type stripping.
- **A Chromium build** — `npx playwright install chromium-headless-shell` (add
  `--with-deps` on a bare host). The engine prints this exact command if the browser is
  missing. A host-provided browser is used when present.
- **ffmpeg** — a host `ffmpeg` on `PATH` (set `FFMPEG_BIN` to point at one) is used when
  present. Otherwise `ffmpeg-static` provides it, but npm ≥ 12 blocks its install script,
  so fetch the binary once: `npm run provision:ffmpeg` (or, for this package's own tests,
  it is fetched the same way).

## Run a demo

```bash
# against a static directory, served by the built-in file server
sprintshow run demo.md --serve-dir ./public

# against a dev server this command spins up and tears down
sprintshow run demo.md --serve "npm run dev" --port 5173

# against a server you already have running
sprintshow run demo.md --base-url http://localhost:3000

# a deterministic, frame-exact proof cut instead of the continuous walkthrough
sprintshow run demo.md --serve-dir ./public --mode proof
```

The MP4 lands at `demos/<script-name>.mp4` by default (`-o` to override). Useful flags:
`--no-narrate`, `--music <file.mp3>` (a background bed under the narration), `--keep` (keep
the `.captures/<run>/` working dir), `--headed`.

**Narration is optional.** With `OPENAI_API_KEY` set, each step is voiced (`tts-1`/`nova`;
override with `DEMO_TTS_MODEL` / `DEMO_TTS_VOICE`) and mixed in. Without a key — or on any
synthesis failure — the video is **silent and captioned**. Narration is best-effort and
can never break the video.

### Lint before you capture

A script can parse and run yet capture nothing worth watching. The linter reads a script
exactly as the driver will and reports what the driver would silently ignore:

```bash
sprintshow lint demo.md          # --strict makes warnings non-zero
```

## Demo-script format

```markdown
# Demo: <title>

**Start:** `/path?query`          ← joined onto the server origin

<free prose → the cover subtitle>

## Steps

1. **<caption shown on screen, spoken as narration>**
   `<action>`                     ← 0+ backtick directives, run in order
   <free prose → step description>
   _Prove:_ <human prose> `<assertion>`
   _Fail if:_ <human prose> `<assertion>`

## Scrutiny                        ← optional; rendered as a closing card
- <what a viewer should check critically>
```

**Actions:** `goto <path>` · `wait <ms>` · `waitFor <selector>` ·
`waitForText <selector> ~ <substring>` · `click <selector>` · `type <selector> ~ <text>` ·
`scroll <selector>` (centre a below-the-fold element so the frame shows it).

**Assertions** (in `_Prove:_` / `_Fail if:_`): `visible <sel>` · `hidden <sel>` ·
`count <sel> <op> <n>` (`>= > == <= <`) · `text <sel> ~ <matcher>` · `eval <js>`. A matcher
is `/regex/`, `"substring"`, or a bare substring. `_Prove:_` must hold (polled); `_Fail if:_`
fails the step if it matches.

A draft in the generic `demo:capture` dialect — an `**Auth:**` line, a `## Scrutiny`
section, and prose-only `_Prove:_`/`_Fail if:_` — parses and runs unedited (its steps record
*manual* proofs). Adapting it is additive: add actions and assertions, never restructure the
file. `demos/sample.md` is a worked example.

## As a library

The drivers are importable. `captureProof` takes a page you have already prepared — the
Playwright **seed-test bootstrap**: authenticate or arm the app in a test, then hand the
page to the engine (see [`examples/seed-test`](examples/seed-test)).

```ts
import { captureProof } from '@zookanalytics/sprintshow';

const result = await captureProof({
  page,                 // a ready Playwright Page (you own the browser + server)
  baseUrl: 'http://localhost:3000',
  demo: './demo.md',    // path or parsed Demo
  outputPath: 'out.mp4',
});
```

## The agent / MCP path

An agent drives the browser itself through `@playwright/mcp`, screenshotting each step into
a captures directory and writing a `manifest.json`, then calls `assemble` to produce the
narrated MP4:

```bash
sprintshow assemble .captures/<run> -o out.mp4
```

See [`examples/agent-mcp`](examples/agent-mcp) for the MCP wiring and the manifest shape.

## Committing demos

Assembled MP4s are stored in **git-LFS** (`.gitattributes` tracks `*.mp4`): a small pointer
goes in git history, the bytes go to LFS storage. Run `git lfs install` once per machine
before committing one. The linter flags a missing LFS filter or a machine without git-lfs.

## License

[AGPL-3.0](LICENSE). Running the tool to produce a video imposes nothing on the video or on
your app; the copyleft covers `sprintshow` itself and derivative works of it.
