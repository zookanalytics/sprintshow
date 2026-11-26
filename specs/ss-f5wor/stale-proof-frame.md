---
name: Stale iOS proof frames — what ss-f5wor found
description: Why an iOS proof video's frame could show the screen from before a step whose proof held, what was measured on a loaded macOS host, and the design that draws a settled page from the device's own screenshot. It also records what that leaves for a walkthrough's recording, and the designs weighed against it.
---

# Stale iOS proof frames

A proof capture of `demos/ios.md` on the sample app showed, as the frame of step 3, "Add a
second task with the Return key", one task and the keyboard up, though the step's proof,
`count task == 2`, held. The following frame showed three tasks. It was reported from a
demo review of gc-toolkit PR #1551, and seen in three captures there.

## What was measured

On the host (macOS 27, Xcode 27.0, the iOS 27.0 runtime, 18 cores) on 2026-11-26, an
instrumented copy of the engine at 626bf53 logged each frame of the stream as it reached
the engine, each frame drawn, each settle, and the frame drawn when the proof frame was
taken. It took the device's own screenshot right after each proof frame and saved every
frame of the stream. Six proof runs of `demos/ios.md` went through `--base-url` on one
device, with the app relaunched before each.

- Step 3's frame showed the keyboard, the screen from before the Return, in the two runs at
  a load average of about 490 and 515, and the step's result in the four at 185 to 440.
- In the first of the two, no frame reached the engine for 2.5 s, through all of step 3:
  its typing, its Return, its proof and the settle's element query. The settle then took
  the first frame that arrived, 0.29 s after the settle began and past the 120 ms it waits
  once its query is answered. That frame showed the field empty and the keyboard up with
  one task: the screen before step 3's typing, about 2 s earlier. The device's screenshot
  taken 0.3 s later showed two tasks and the keyboard down. Six byte-identical frames then
  arrived within 30 ms of each other.
- In the second, the frame the settle took arrived 0.35 s after the settle began and
  showed the field just tapped, its AutoFill bubble up and nothing typed, about 1.5 s
  before.
- A run through `--serve` with `--screenshots` and one without, at a load of about 9 and
  124, showed step 3's result. With `--screenshots`, the step's PNG is taken between the
  settle and the proof frame, so the proof frame is drawn later.

The device drew the step's result in time. The settle drew a frame taken before it.

## Why the frame was stale

The settle took a frame's arrival for its capture, give or take `FRAME_LAG_MS`. A frame of
WebDriverAgent's stream carries no time it was taken, and WebDriverAgent 16.17.7, the one
the XCUITest driver 12.22.8 installs, makes its frames in a pipeline that can fall seconds
behind its commands (`FBMjpegServer.m`, `FBImageProcessor.m`):

- One screenshot is taken per tick, through testmanagerd, on a serial queue at utility
  quality of service, with a 1 s limit, and a failed one backs the loop off.
- The scaler keeps only the newest screenshot, and sends it to every handler queued while
  it was busy. That is the burst of identical frames.
- Each client holds up to four frames waiting to be sent, and newer ones are dropped.

WebDriverAgent went on answering commands while no frame came: the whole of step 3, its
typing, Return, proof and the settle's query, ran in the 2.5 s with no frame. So the step
and its proof ran ahead of the frames.

## The design

A page captured only once each step has settled needs one image of the screen after the
step, not the screen as it changes. That page is a proof video's frames, each step's PNG,
and `sprintshow screenshot`'s page. It now shows the device's own screenshot: the settle
sends its element query, asks Appium for a screenshot and draws it on the device page. A
screenshot is taken once it is asked for. Appium sends `GET /screenshot` on to
WebDriverAgent's, which takes one, and falls back to a CoreSimulator capture. It answers
from a stream only when the session names `mjpegScreenshotUrl`, which the engine does not.
The engine asks once the step's proof is checked, so the frame cannot show the screen from
before the step. The step's PNG is the screenshot the page shows, so a proof run's PNG and
frame agree.

A page recorded as it changes, the walkthrough's, still draws the stream, because a
recording needs the screen as it changes. `openSurface` and `connectSurface` take
`recorded` for it, and `showIosApp` takes `stream`. Unless `recorded` is given, the page
shows the device's screenshots, so a driver that leaves it out gets proof frames that
cannot be stale, and one that records the page without it shows the screen change only at
each settle.

Weighed against it:

- A larger `FRAME_LAG_MS`. The lag measured was about 2 s at a load average near 500, and
  nothing in the pipeline bounds it, so a bound picked now fails under a heavier load.
- Drawing the device's screenshot at every settle, the walkthrough's included. The
  recording's next frames from the stream can be older than the screenshot, so the video
  would go back in time.
- Telling a frame's capture time from the stream. Its parts carry none, and a client that
  connects after a frame was taken is sent it, since each frame goes to the clients
  connected when it is sent.

## What it leaves

A walkthrough's settle still takes a frame's arrival for its capture, so under load a
walkthrough can film a step's end late, the next step's caption over the screen from
before. `src/ios.ts` states the limit, and ss-2gpha tracks it, with a direction to weigh:
settle on the device's screenshot, and hold the stream's frames from the page until one
shows what it shows.
