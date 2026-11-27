---
name: Terminal captures on a loaded host — what ss-o4n1 found
description: Why captures in test/terminal.test.ts ran out of time on 2026-10-26, where a capture spends its time limit, the measurements that show the file's concurrent tests make each of its round trips several times slower, and why the tests that take a capture in the test process run after them.
---

# Terminal captures on a loaded host

On 2026-10-26, at load averages of 94 to 140 on this host's 18 cores, captures of the
terminal window in `test/terminal.test.ts` timed out. The default capture in "--full-page
holds the whole session in the window; the default holds the screen" ran out of the 15 s
that `captureScreenshot` gives it (`ACTION_TIMEOUT`), in one run of origin/main and one of
another branch. The full-screen program test's own `locator.screenshot()` ran out of
Playwright's default 30 s once. Playwright reported the time left once it had found the
window, 12264 ms and 11660 ms of 15000. Finding an element that already existed had taken
2.7 s and 3.3 s.

## Why the captures ran out of time then

Until that day every process the city started ran in one launchd job that set no
`ProcessType`, and macOS throttled the job as a whole. A busy loop inside the job got 9 to
27 percent of a core, and the same loop alone in a job of its own got 93 percent. The
city's sessions waited 22 to 30 times as long as they ran, while about half the host's CPU
sat idle. The test suites ran inside that job (tk-mnsm05s). The operator ruled that day
that the throttle is lifted outside the city (tk-56yjgxg). When read on 2026-11-26, the
supervisor's launchd plist set `ProcessType` to Interactive and `Nice` to 5. The captures
timed out before the ruling, and the tracker has no confirmation from any gate since.

## What a capture is

An element screenshot in Playwright 1.63 is a chain of protocol round trips between the
test process and the browser, each sent once the one before has answered, all under one
time limit. The protocol log of one capture of the terminal window shows them in order:

1. find the element;
2. prepare the page for the screenshot, in every frame;
3. wait for `document.fonts.ready`;
4. describe and resolve the node;
5. check that the element is visible and stable, which takes two animation frames;
6. scroll it into view;
7. read its box model;
8. read the page's scroll offset, in two calls;
9. set a transparent background;
10. read the layout metrics;
11. capture the clip (`Page.captureScreenshot`);
12. reset the background and undo step 2.

`page.screenshot()` skips the element steps. At a load average of about 50, a capture of a
small terminal window takes 60 to 80 ms in all.

## How it was measured

On 2026-11-26, on origin/main at 626bf53:

- Playwright's protocol log (`DEBUG=pw:protocol`, written to a file by `DEBUG_FILE`)
  timestamps every request and response. Pairing them by session and id gives each phase
  of each capture.
- Copies of main and of this branch, instrumented alike, logged each capture's whole call
  time and its budget.
- Load came from other agents' work on the host, much of it iOS simulators, and from two to
  four loops of the full suite beside the file: every test file but the live iOS one, all at
  once, as `npm test` runs them.

## What it showed

**No capture timed out.** Main's file ran 53 times alone and inside 95 full-suite runs, at
load averages from 36 to 896, and every capture in it finished within its budget.
A busy loop started from an agent's shell got 4 to 8 percent of a core at the top of that
range. The file's failures in those runs were a teardown check, described at the end.

**No single wait uses up the budget.** Over 220 captures in 20 runs of main's file, the
mean of each phase was: prepare 43 ms, fonts 28 ms, the stability check's two frames 32 ms
(at most 360 ms), scroll 15 ms, box 9 ms and layout metrics 18 ms. The capture itself of a
small window took a median of 130 ms, at most 715 ms. A capture runs out of time when every
round trip is slow, as on 2026-10-26: at the 1.3 s or more per round trip that finding the
window took then, the chain does not fit in 15 s.

**The concurrent block makes each round trip several times slower.** In those 20 runs, at
load averages from 37 to 869, the round-trip phases of the 180 captures taken during the
`concurrency: true` block averaged 168 ms, at most 1020 ms. The 40 captures taken after it,
the two thousand-bar captures, averaged 40 ms, at most 115 ms. During the block the test
process carries up to about 1000 protocol messages a second. More than half of them carry
the terminals' typing and what their shells print back: each typed key is two key events
and a binding call into the test process with its answer, and the shell's output, its echo
included, comes back as writes to the page.

**Moving the captures out of the block takes the crowding away.** Runs of main (A) and of
this branch (B) alternated, eight of each, beside two to four loops of the full suite:

| Runs | Load averages | Captures in the test process: mean, longest | Least margin | Captures by the CLI tests: mean, longest |
|---|---|---|---|---|
| A, all 8 | 63 to 583 | 851 ms, 3521 ms | 4x | 261 ms, 731 ms |
| B, all 8 | 64 to 583 | 140 ms, 397 ms | 38x | 210 ms, 666 ms |
| A, the 5 at load 90 or more | 121 to 583 | 1101 ms, 3521 ms | 4x | 352 ms, 731 ms |
| B, the 5 at load 90 or more | 93 to 583 | 145 ms, 261 ms | 57x | 229 ms, 666 ms |

Each run's load is the one-minute average at its start and at its end. A capture's margin
is its budget over the time it took. The least margin in both A rows is the default capture
of "--full-page holds the whole session in the window; the default holds the screen", 3521
ms of its 15000. Every B run passed, and one A run failed the teardown test described at
the end.

The captures that the block's CLI tests take in processes of their own stay in the block in
both, and serve as the control.

**The file takes longer.** The moved tests took 12 to 25 s one at a time, more as the load
rose. In the alternating runs, each B run took 2 to 73 s longer than the A run before it, a
median of 16 s.

Whether that reaches a whole suite run depends on which file finishes last. In three
alternating pairs of full-suite runs without the live iOS test, main took 40, 46 and 58 s
and the branch 60, 105 and 59 s, while the load swung between 59 and 422. That is too
noisy to give a figure. A suite run with the iOS tests, as this host's gates run it, took
3 min 31 s on 2026-11-20, longer than any run of the terminal file here, which took at most
116 s.

## What changed

The tests that take a capture in the test process run after the concurrent block, one at a
time, in a `describe` block of their own: the full-screen program test, the two
`--full-page` session tests, the test that the shell and its jobs end before the capture
returns, and the four tests of a video frame at the limits of the terminal sizes. The two
thousand-bar captures already ran after the block.

The moved tests could instead run side by side with each other, after the block. In
three alternating runs of each layout beside the full suite, at load averages from 131 to
422, their captures took a mean of 338 ms side by side, at most 1139 ms, against 135 ms
and 280 ms one at a time. The moved tests took 5.5 to 7.4 s side by side, and 13.5 to
18.7 s one at a time. One at a time keeps about three times the margin, and a rule a new
test can follow: nothing else runs beside a capture taken in the test process.

## What it leaves in place

- **The host's load.** Each round trip still slows down as the load rises, on the branch as
  on main. The branch takes away the multiplier the file adds to it.
- **The throttle's removal.** It is set outside the city. The close reason of gascity's
  gc-i147mx records that a manual `gc supervisor install` or a `gc start` re-render removes
  it. With the throttle back, every round trip slows again, and the branch's
  captures have the margin measured above.
- **Every budget.** `captureScreenshot` still gives the window `ACTION_TIMEOUT`, and a
  full-page capture time for each tile on top. The tests' own captures still have
  Playwright's 30 s. A real capture's budget is unchanged too. The CLI's screenshot command
  runs `captureScreenshot` alone in its own process and browser (`src/run.ts`), where no
  other test's traffic crowds it.
- **The block's CLI tests.** They take their captures in processes of their own, beside the
  block. The block's traffic through the test process does not reach them, and the host's
  load does.

## Other failures seen while measuring

- `test/vercel.test.ts:361` failed in 2 of the full-suite runs on main with "Missing
  expected rejection", and `test/vercel.test.ts:206` failed once as it did on 2026-11-12.
  `passVercelSignIn` returns without a word when its first walk throws, the path ss-p8uuk
  tracks, and the failures are recorded there.
- `test/walkthrough.test.ts:87` failed once: the video showed a frame the page drew one
  40 ms slot later than the test's bound allows. ss-yz2kc tracks it.
- `test/terminal.test.ts:486` failed four times on main, three of them in full-suite runs:
  a background job or a full-screen program that handles SIGHUP outlived the capture. That
  is a teardown defect, not a capture's time limit, and ss-1525b tracks it. Each time the
  test ran in the concurrent block. It passed in every run of the branch, where it runs
  after the block, but those runs are too few to say the move ends it.
