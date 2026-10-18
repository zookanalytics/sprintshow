---
name: Terminal surface — what ss-71qt decided
description: The design ss-71qt settled before building SprintShow's terminal surface. It covers how a script declares a terminal engagement, the pty session's lifecycle, the verbs that drive it, how each proof reads terminal state, how the captures frame it, and the sample that shows it.
---

# The terminal surface

A demo script that declares `**Terminal:**` drives a shell instead of a page. The
engine serves the terminal itself: an xterm.js emulator in a page the engine writes,
attached to a bash session in a pseudo-terminal (pty). The script's steps type commands
and press keys through the grammar and the step runner (`runStep`) a page script uses,
and each step's proof is checked against the terminal's screen, cursor and exit status.
Both captures take a terminal script. `sprintshow screenshot` saves the terminal window
as a PNG, and `sprintshow run` films the engagement in either video mode, with its
captions and narration.

## Decisions

### The emulator owns the escape sequences

The terminal is xterm.js (`@xterm/xterm`). The engine writes its page into the capture's
browser page with `setContent` and adds xterm's bundle and stylesheet as tags, so no
server or port is involved and a terminal capture listens on nothing. What the shell
prints goes to xterm unread, and every read of terminal state goes through xterm's buffer
API. Colours, cursor addressing, scrolling regions and the alternate screen are xterm's to
interpret, and nothing in the engine parses an escape sequence. xterm draws with its DOM
renderer, so its text stays text: sharp at any `--scale`, with no GPU needed in headless
Chromium.

### The pty is @lydell/node-pty

node-pty is the pty xterm.js is built against. Its own package ships prebuilt binaries
for macOS and Windows only. On Linux its install script builds it with node-gyp, which
needs a compiler, and npm 12 blocks that script unless the user allows it.
`@lydell/node-pty` 1.1.0 is node-pty (1.1.0-beta14) with each platform's binary in an
optional package of its own and no install script, so it installs on macOS and Linux with
nothing to build or allow. The engine imports it only when a terminal script runs. A page
capture never loads a native module, and on a host with no binary for its platform only a
terminal script fails, with the loader's message.

`script(1)` needs no native code at all. It was set aside because macOS and Linux ship
different implementations of it with different flags, so the engine would carry a variant
for each.

### One script drives one surface

A script that declares `**Terminal:**` is a terminal script, and any other is a page
script. The verbs and assertions differ by surface, and the parser reads only the declared
surface's. In a page script, `run` and `press` in backticks stay prose as they always
have, and a page directive in a terminal script stays prose too. The linter reports a
directive or an assertion of the other surface, so a script that mixes them is caught
before a capture.

### Declaring a terminal engagement

`**Terminal:** 100x30` names the terminal's size in columns and rows. The size is optional
and defaults to 100x30. A size outside 20 to 300 columns or 5 to 100 rows is refused when
the script is parsed. A terminal script needs no `**Start:**`. It takes no server, so `run`
and `screenshot` refuse `--base-url`, `--serve`, `--serve-dir` and `--port` for one.
`--cwd` names the directory its shell starts in, as it names a `--serve` command's for a
page script, and defaults to the working directory.

### The session

The surface opens before the first step:

1. The engine writes the terminal page, and sizes its font so that the declared size fills
   the stage (see Framing the captures).
2. It spawns `bash --noprofile --norc` from `PATH` in a pty of the declared size, in
   `--cwd`. The shell inherits the engine's environment with these changes:
   - `TERM=xterm-256color` and `COLORTERM=truecolor`.
   - `PS1` is a `$ ` prompt that carries the shell-integration marks.
   - `HISTFILE=/dev/null`, so a demo writes nothing to the user's history.
   - `INPUTRC=/dev/null`, so the user's key bindings do not change what a key does.
   - `BASH_SILENCE_DEPRECATION_WARNING=1`, so macOS's bash prints no notice at start.
   - `LANG` names a UTF-8 locale when the environment names no locale.
   - The variables that would change the prompt, the line editing, or what bash runs at
     start are removed: `PROMPT_COMMAND`, `PS0`, `PS2`, `SHELLOPTS`, `BASHOPTS`, `BASH_ENV`
     and `ENV`. So are the variables that describe another terminal, such as `COLUMNS`,
     `LINES`, `TMUX` and `TERM_PROGRAM`.
3. What the pty prints is handed to xterm in the order it arrived, batched while a hand-off
   is in flight. What a step types goes to xterm's own input. xterm encodes each key for
   the terminal's current modes, an arrow key in application cursor-key mode for one, and
   the bytes go to the pty.
4. The engine waits up to 15 s for the shell's first prompt, and fails the capture if none
   shows.

Before a still is taken, the surface settles: the pty's output has been handed over and
parsed, and xterm has drawn it. The session ends once the capture no longer shows the
terminal, and on any error. For a still and for proof mode, that is after the last step.
The walkthrough films its closing card over the terminal, and ends the session once the
recording is flushed, so the time a program takes to end is not filmed.

Ending the session ends the shell and every job it runs. Each of the session's process
groups gets SIGHUP: the shell's own, and one for each job, which holds whatever that job
started. Any group still running two seconds later gets SIGKILL, whether it is the shell
or a job that outlived it, such as a program that handles SIGHUP. The capture returns
once they have exited. The groups are read before the hang-up, while the shell leads the
session, because once the shell exits nothing ties its jobs to the terminal. On Linux the
engine lists the session by its id. A macOS process listing shows no session id, so there
it reads the processes whose controlling terminal is the shell's. The engine reads the
session only while the shell leads it, so a job still running after a script exits the
shell itself is left running.

The shell is bash. A shell reports each command's end and exit status only through a
prompt the engine writes, and bash is on every macOS and mainstream Linux host. The marks
work under macOS's bash 3.2 as under bash 5.

### Shell-integration marks

The prompt carries semantic-prompt marks (OSC 133). `D;<status>` reports the exit status
of the command that just finished, `A` marks where a prompt begins, and `B` where it ends.
xterm hands each mark to a handler the engine registers, and draws nothing for it. From
the marks, the terminal page keeps three facts: how many prompts the shell has shown,
whether input was submitted with an Enter key since the last one, and the status the last
finished command reported.

### The verbs

| Verb | What it does |
|---|---|
| `run <command line>` | Waits for the shell's prompt, types the line and presses Enter. It then waits until the command finishes (the next prompt shows), a full-screen program takes over the screen, or the shell exits, for up to 60 s, and logs the command's exit status. When the 60 s run out, the log names the pattern below. |
| `press <keys>` | Presses each key in turn. A key is a name as Playwright's keyboard names it (`Enter`, `Escape`, `ArrowDown`, `Space`, `F1`, `Control+C`, `q`), or a double-quoted string, whose text it types. It waits for nothing. |
| `waitForScreen <matcher>` | Waits up to 15 s for the screen's text to match. |
| `wait <ms>` | Pauses, as in a page script. |

A program that waits for input on the normal screen, such as `python3`, `node`,
`npm init` or a `read` prompt, shows no prompt of the shell's, takes no alternate screen
and does not exit, so `run` would wait out its 60 s on it. Such a program is started with
`press "<command>" Enter` and followed by `waitForScreen` on the prompt it shows, not with
`run`. For Python that is `press "python3" Enter` and then `waitForScreen />>>$/`. The
screen's rows lose their trailing blanks, so the `>>> ` prompt reads as `>>>`. `run` does
not settle when the output goes quiet, because a slow command such as `npm install` pauses
between bursts of output, and a quiet spell would end its wait early.

In the walkthrough, `run` and `press` type at the pace a page script's typing uses, pause
between keys, and hold a beat once they are done, so a viewer sees each one land.

### How a proof reads terminal state

A terminal proof is a `_Prove:_` or `_Fail if:_` line whose assertion is one of four
kinds. The step runner checks it as it checks a page proof. A `_Prove:_` assertion is
polled until it holds, for up to 10 s, and a `_Fail if:_` assertion is checked once and
fails the step if it holds.

**The screen** is what the terminal displays now. On the normal screen, it is the last
`rows` lines of the buffer, not the scrollback above them. While a full-screen program
holds the alternate screen, it is that screen.

- `screen ~ <matcher>` holds when the screen's text matches. The text is the screen's
  rows, top to bottom, with each row's trailing blanks dropped. A row that the terminal
  wrapped onto the next one is joined to it with no line break, so text that wrapped at
  the right edge reads as one line. Every other row ends in a line break. A wide character
  reads once.
- `row <n> ~ <matcher>` holds when row `n` of the screen matches, with its trailing blanks
  dropped. Row 1 is the top row, and row -1 the bottom one. A row past the screen's edge
  never matches.
- `cursor <row> <col>` holds when the cursor is at that row and column of the screen. Both
  count from 1, and a negative row counts from the bottom. A cursor parked after the last
  column reads as the last column, where the terminal shows it.
- `exit <op> <n>` holds when the exit status of the last command the shell finished
  compares with `n` by `op`, one of `>=`, `>`, `==`, `<=` and `<`. The status is the one
  the shell reported at its latest prompt, for a command submitted after the prompt before
  it. From an Enter key until the next prompt a command is running, and no `exit`
  assertion holds. None holds before the first command either. Once the shell itself has
  exited, its own exit status is the one compared.

A matcher is `/regex/`, `"substring"` or a bare substring, as in a page script's `text`
assertion. A regex is tested with the `m` flag, so `^` and `$` match at each row's start
and end. The page assertions (`visible`, `hidden`, `count`, `text` and `eval`) are not
terminal assertions. They read a page's DOM, and the terminal page's DOM is the engine's,
not the demo's.

### Framing the captures

The terminal page draws a window: a title bar with the demo's title, and the terminal
below it in a dark theme that matches the engine's cards. The font size is the largest,
from 24 px down, at which the window fits the stage. The stage is the viewport less a
margin and the band the caption bar takes, so one script shows the same text size in a
still and in a video. Every size the parser accepts fits the drivers' 1280x900 viewport
whole, with no column or row outside a video frame or under its caption bar, and the
largest sizes draw at a few pixels. A page too small to fit a terminal even at 1 px
refuses it before its shell starts.

- **The still.** `sprintshow screenshot` captures the window, not the viewport. The page
  paints nothing around the window, and a terminal capture always leaves out the default
  white background, so the window's rounded corners are transparent. `--full-page`
  captures the whole session instead of the screen. The window is drawn with one row for
  each line the session holds, from the scrollback's first line to the last line with
  text or the cursor, whichever is lower. While a full-screen program holds the
  alternate screen, `--full-page` captures that screen. `--selector` is refused for a
  terminal script, because the terminal page's elements are the engine's. `--scale` and
  the exit codes work as they do for a page.
- **The videos.** Proof mode and the walkthrough show the window centred on a dark
  backdrop, above the caption band. Proof mode frames each step once the terminal has
  settled.

### The sample

`demos/terminal.md` drives `examples/sample-cli`, the sample app's sprint board in a
terminal. `tasks.md` holds the backlog, and `board.mjs` is a small full-screen program,
written for the sample so that it runs wherever the engine does. It switches to the
alternate screen and to application cursor-key mode, draws a box and a status bar by
cursor addressing in 256 and 24-bit colour, and restores the shell's screen when it quits.
The script reads the backlog, runs a summary command, opens the board, moves the cursor,
toggles a task and quits. Each step's proof reads the screen, a row, the cursor or the
exit status.

```bash
sprintshow run demos/terminal.md --cwd examples/sample-cli
sprintshow screenshot demos/terminal.md --cwd examples/sample-cli --scale 2 -o terminal.png
```

## The pack's terminal kind on this surface

gc-toolkit's demo check renders a command's output pack-side (tk-vd66j1.7), and retires
that renderer onto this surface in tk-vd66j1.11. `sprintshow help` lists terminal scripts,
so the pack can refuse an engine that predates them before anything runs. A one-step
script whose step is `run <command>` shows the command after a `$ ` prompt and then its
output, and `--full-page` captures output longer than the screen whole. The step's log
gives the command's exit status, which the pack reports without judging it. Output
captured earlier is shown by a step that prints it, such as `run cat <file>`.
