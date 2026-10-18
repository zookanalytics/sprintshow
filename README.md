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

# the same for a command-line session, full-screen program included
npx @zookanalytics/sprintshow run demos/terminal.md --cwd examples/sample-cli
```

## What it does

A demo script is markdown that reads as a human walkthrough and carries machine-checkable
directives, so the *same file* documents the demo and drives it. Each step can assert
something against the live page (`visible`, `count`, `text`, …), so what the video shows
is verified behaviour rather than a screen tour — demos are for communicating to people,
and the checks keep them honest.

One script drives each capture:

- **walkthrough** (the `run` default) — one continuous recorded take, driven at a human
  pace with a synthetic cursor and live on-screen captions. The watchable,
  library/marketing cut.
- **proof** (`run --mode proof`) — one screenshot per step, each with its assertion checked
  and its caption burned in. Deterministic and frame-exact; the shape an agent produces when
  it drives the browser itself.
- **screenshot** (`sprintshow screenshot`) — the steps run and each proof is checked as in
  proof mode, and the state the last step leaves is saved as one PNG. It draws no caption
  and needs neither ffmpeg nor a narration key.

A script drives an app in a browser page, or, when it declares `**Terminal:**`, a shell in
a terminal the engine serves itself: commands typed, their output, and full-screen programs.
Every capture takes either kind (see [Terminal demos](#terminal-demos)).

## Install

```bash
npm install -D @zookanalytics/sprintshow
```

Prerequisites, fetched on demand rather than assumed:

- **Node ≥ 22.18** — runs the engine, and the tests via native type stripping.
- **A Chromium build** — `npx playwright install chromium-headless-shell` (add
  `--with-deps` on a bare host). The engine prints this exact command if the browser is
  missing. A host-provided browser is used when present.
- **ffmpeg**, for video (a screenshot runs without it) — a host `ffmpeg` on `PATH` (set
  `FFMPEG_BIN` to point at one) is used when present. Otherwise `ffmpeg-static` provides
  it, but npm ≥ 12 blocks its install script, so fetch the binary once:
  `npm run provision:ffmpeg` (or, for this package's own tests, it is fetched the same way).
- **bash on `PATH`**, for a terminal demo. Its pty comes from `@lydell/node-pty`, which
  installs a prebuilt binary for macOS or Linux (x64 or arm64) with nothing to build or
  allow.

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

`--serve-dir` listens on a free port unless `--port` names one, so captures can run side
by side on one host. `--serve` waits on port 5173 unless `--port` names the port its
command binds.

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

## Capture a screenshot

`sprintshow screenshot` drives a script's steps and checks each step's proof as proof mode
does, then saves the state the last step leaves as one PNG. It draws no caption, pointer or
card, and it needs neither ffmpeg nor a narration key.

```bash
# the sample board after the sample's steps, at 2x so its text stays sharp in a PR comment
sprintshow screenshot demos/sample.md --serve-dir examples/sample-app --selector '#board' --scale 2 -o board.png
```

It takes the server options `run` takes (`--base-url`, `--serve`, `--serve-dir`, `--port`,
`--cwd`), and `-o` names the PNG. It captures the viewport unless told otherwise.
`--full-page` captures the whole scrollable page, and `--selector <css>` captures one
element, its first match, once that element is visible. `--scale <n>` sets the device scale
factor. `--transparent` leaves out the page's default white background, so on a page that
paints no background of its own, an element with rounded corners keeps transparent corners.

Chromium draws one capture in tiles, and holds only so many of them at once: about 120
million device pixels' worth. A `--full-page` capture larger than that holds what fits.
A page keeps its top and a terminal session keeps its last lines, and the log says how
much the capture holds. At `--scale 2`, a 1280-pixel-wide page keeps about its top 22,000
CSS pixels, and an 80-column terminal about its last 870 lines.

## Terminal demos

A script that declares `**Terminal:**` drives a bash session instead of a page. The engine
serves the terminal itself: xterm.js, in a page of its own, attached to the shell in a
pseudo-terminal. xterm draws everything the shell's programs print, colours, cursor
addressing and the alternate screen included, so a full-screen program such as an editor
or a curses dashboard is captured as it looks. The steps go through the same grammar and
step runner as a page script's, and every capture takes the script.

```markdown
# Demo: Sprint board in a terminal

**Terminal:** 100x30                ← columns x rows; optional, 100x30 by default

## Steps

1. **A command counts the board**
   `run node board.mjs --summary`
   _Prove:_ three tasks, one done — `screen ~ /^3 tasks · 1 done$/`

2. **The board opens full screen**
   `run node board.mjs`
   `press ArrowDown Space`
   _Prove:_ the status bar counts two done — `row -1 ~ /2 of 3 done$/`
```

```bash
sprintshow run demos/terminal.md --cwd examples/sample-cli
sprintshow screenshot demos/terminal.md --cwd examples/sample-cli --scale 2 -o terminal.png
```

A terminal script needs no `**Start:**` and takes no server: `--base-url`, `--serve`,
`--serve-dir` and `--port` are refused for one. Its shell starts in `--cwd` (default: the
working directory) as `bash --noprofile --norc`, with a `$ ` prompt, no history file, no
`inputrc` and `TERM=xterm-256color`. It inherits the engine's environment, less the
variables that describe another terminal, such as `TMUX` and `COLUMNS`.

**Actions:**

- `run <command line>` waits for the prompt, types the line and presses Enter. It then
  waits until the command finishes, a full-screen program takes over the screen, or the
  shell exits, for up to 60s, and logs the command's exit status. A program that waits for
  input on the normal screen, such as `python3`, `node`, `npm init` or a `read` prompt,
  does none of these, so it is started with `press "<command>" Enter` and followed by
  `waitForScreen` on its prompt, not with `run`. For Python that is `press "python3" Enter`
  and then `waitForScreen />>>$/`. A row loses its trailing blanks, so the `>>> ` prompt
  reads as `>>>`.
- `press <keys>` presses each key in turn: a key as Playwright names it (`Enter`,
  `Escape`, `ArrowDown`, `Space`, `F1`, `Control+C`, `q`), or a `"quoted string"`, which
  it types.
- `waitForScreen <matcher>` waits for the screen's text to match.
- `wait <ms>` pauses.

**Assertions** read the terminal's state. The screen is what the terminal displays now: on
the normal screen its last rows, not the scrollback above them, and while a full-screen
program holds the alternate screen, that screen.

- `screen ~ <matcher>`: the screen's text matches. Each row loses its trailing blanks, and
  a row the terminal wrapped joins the next with no line break.
- `row <n> ~ <matcher>`: row `n` matches. Row 1 is the top and row -1 the bottom.
- `cursor <row> <col>`: the cursor is at that row and column, counted from 1.
- `exit <op> <n>`: the exit status of the last command the shell finished compares with
  `n` (`>= > == <= <`). While a command runs, no `exit` assertion holds.

A matcher is as in a page script's `text` assertion, and a `/regex/` is tested with the
`m` flag, so `^` and `$` match at each row's start and end.

**Captures.** `sprintshow screenshot` saves the terminal window, title bar included, with
its rounded corners transparent. `--full-page` captures the whole session instead of the
screen: one row for each line it holds, scrollback included. A session longer than one
capture holds keeps its last lines (see [Capture a screenshot](#capture-a-screenshot)).
`--selector` is for page scripts. The videos show the window on a dark backdrop, above the caption bar. Every
capture draws the window at the largest font size, up to 24 px, at which it fits a video
frame above the caption bar, so a very wide or tall terminal draws small. Once a capture
is done, the shell and every program it still runs are ended, and a program that ignores
SIGHUP is killed.
`specs/ss-71qt/design.md` records why the surface is built this way.

## Exit codes

The exit code of `run` and `screenshot` says what was saved:

- **0**: the output (the MP4 or the PNG) is saved and every step's proof held.
- **3**: the output is saved, but at least one step's proof failed. The output still shows
  what failed, and `run` keeps its `.captures/<run>/` working dir.
- **1**: no output is saved.

## Demo-script format

```markdown
# Demo: <title>

**Start:** `/path?query`          ← joined onto the server origin (a page script)
**Terminal:** 100x30              ← or this, for a terminal script

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
`scroll <selector>` (centre a below-the-fold element so the frame shows it). A terminal
script has [its own](#terminal-demos), and each kind of script reads only its own actions
and assertions.

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

`captureScreenshot` takes the same kind of page and saves one PNG in place of the MP4.
`runDemo` and `runScreenshot` bring up the server and the browser themselves, as the CLI
does. A custom driver that runs its steps through `runStep` checks each proof as the
built-in captures do. For a terminal script, a driver takes a `cwd` in place of a
`baseUrl`, and `openSurface` brings up what any script drives: the app at its start path,
or the engine's terminal and its shell.

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
