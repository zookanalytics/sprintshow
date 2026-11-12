---
name: iOS app capture and golden images — what ss-pqt8i decided
description: The design ss-pqt8i settled for capturing an iOS app on a throwaway iOS Simulator device and for keeping any capture's screenshots as golden images. It covers what drives the app, what a run takes as its build, the device each pass runs on, how screenshots are collected and named, and how a run is compared with its golden images. It also records what was measured on a macOS host with Xcode 27.
---

# Capturing an iOS app, and golden images

`sprintshow simulator` runs an iOS app's own UI tests on a throwaway iOS Simulator device,
once in light and once in dark, and saves each screenshot the tests attach as
`<name>.<appearance>.png`. `sprintshow golden` compares a run's screenshots with golden
images kept in a repository, and rewrites them on request. `sprintshow screenshot
--each-step` gives a page or terminal script the same form of run: one PNG for each step.

## Decisions

### The app's own UI tests drive it

A step of an iOS capture is a screenshot a UI test attaches. The test drives the app with
XCUITest: taps, typing, and waits on elements the screen shows. It attaches a screenshot
where a step ends, under a name it chooses. sprintshow runs the tests and collects the
screenshots. It does not drive the app itself.

These were weighed:

- **`simctl` alone, with launch arguments or URLs.** `xcrun simctl` can install, launch with
  arguments, open a URL and take a screenshot, but it has no way to tap, type or wait on
  an element. Its subcommands are listed by `xcrun simctl help` on Xcode 27, and none of
  them sends input. Steps made of launches could show only the states an app can be
  launched into. The screens behind a tap, such as a session in progress, would need the
  app to grow a launch argument for each one.
- **A driver outside Xcode**, such as idb or Appium. Each adds a tool to install on every
  host that captures, and duplicates what XCUITest does.
- **The app's UI tests.** XCUITest ships with Xcode and drives any screen a person can
  reach. A repository that tests its UI already has the steps written, and a test sets
  its app's launch arguments too, so launch arguments still reach the screens they open.
  Taking screenshots by name inside UI tests is also how App Store screenshots are
  commonly automated, for one in fastlane's `snapshot`.

The UI tests were chosen. A demo script is not used for an iOS app: its steps would only
repeat the names the test attaches, and its directives drive a page or a terminal.

### What a run takes as its build

A run takes a project or a workspace with a scheme, and builds it with `xcodebuild
build-for-testing` for `generic/platform=iOS Simulator` with `CODE_SIGNING_ALLOWED=NO`. A
simulator build needs no signing identity, so a host without the team's certificates
builds it. A run can instead take a build already made, as the `.xctestrun` file
`build-for-testing` writes. That file names the app, the test bundle and the runner that
`xcodebuild test-without-building` installs. A bare `.app` is not taken, because it has no
test runner to drive it.

### A device of its own for each pass

Each appearance's pass runs on a device created for it, from the device type the run
names, on the newest iOS runtime the host has that runs the type, unless `--runtime`
names one. The device is booted with `simctl bootstatus -b`, which boots it and waits
until it is up. The pass then sets the status bar and the appearance, grants the
permissions asked for, and runs the tests. The device is deleted in the pass's `finally`,
so a pass deletes it whether its tests pass, fail, or never start. Two runs on one host
never share a device, and the dark pass never starts from data the light pass left in the
app, such as a record it saved.

A device is named `sprintshow-<pid>-<appearance>-<4 hex digits>`, so one left behind by a
process that was killed outright can be traced to that process. A signal that would end
the process, SIGINT, SIGTERM or SIGHUP, stops the capture's child processes and deletes
its devices first. Then, when nothing else in the process listens for that signal, the
handler raises it again, so the process ends as it would have. A library caller that
handles the signal itself keeps its handler.

### A fixed status bar

Each device's status bar is fixed with `simctl status_bar override` before its tests run:
9:41, Wi-Fi and cellular at full bars, and a charged battery. A screenshot taken with
`XCUIScreen.main.screenshot()` includes the status bar. Without the override, its clock
would change every golden comparison.

### Diagnostics off

`xcodebuild test-without-building` runs with `-collect-test-diagnostics never`. With the
default, a failing test makes `xcodebuild` collect a sysdiagnose of the device through
`simctl diagnose --timeout=600`. On the measuring host, that kept a failed pass running
for more than nine minutes after its test had ended. Testing also runs with
`-parallel-testing-enabled NO`, so the tests run on the pass's own device rather than on
clones of it. Then the appearance, the status bar and the recording all apply to the
device that runs the tests.

### Collecting the screenshots

`xcrun xcresulttool export attachments` writes a result bundle's attachments and a
`manifest.json` that lists each test's attachments, with the exported file and a
suggested name. XCTest stores a named attachment as `<name>_<n>_<UUID>.<extension>`. The
counter was 0 for two attachments a test gave one name, and a UUID told them apart, so
the run takes the name before the counter and numbers repeats itself, in the order the
attachments were made. That order is their timestamps. The manifest lists a test's
attachments out of that order. Only PNGs are kept. A failing test also attaches a screen
recording and a log of synthesized events, which are not screenshots. A name loses the
characters a file name should not hold.

The first attachment given a name keeps it. A later one given it again takes the first of
`-2`, `-3` and so on that no attachment of the pass is given and none has taken, so a name
a test gave, such as `board-2`, stays its own. Names are told apart without regard to
letter case, because the default volume of a Mac takes `Board.light.png` and
`board.light.png` for one file. Each screenshot is copied into the output directory only
where no file has its name yet, so a fault in the naming stops the run rather than write
one screenshot over another.

The summary that `xcresulttool get test-results summary` writes says how many tests passed
and failed, and gives each failure's message. A pass whose bundle holds no test that ran
fails the run, quoting `xcodebuild`'s log. A failed test does not fail the run: its
screenshots are saved and the run exits 3, as a capture whose proof failed does.

`xcodebuild`'s exit status is kept beside the summary. A failed test the summary counts
explains a non-zero exit. A non-zero exit with no failed test counted fails the run,
quoting the log: something outside the tests failed, which the summary does not show, and
the screenshots of the tests that passed may not be all of them.

### The video

`--video` records each pass with `simctl io recordVideo --codec=h264`. The recording
starts once `simctl` writes "Recording started", before the tests run, and is stopped
with SIGINT once they end. `simctl` then finalizes the file. A recording that does not
start leaves its pass without a video and logs why. The video is extra to the screenshots,
as narration is extra to a demo video, so it does not fail the run.

### Golden images are directories of PNGs

A run is a directory of PNGs and so are its golden images, matched by file name. That makes
golden images a matter of files, whatever made them: `simulator`, `screenshot
--each-step`, or anything else that writes PNGs. It also lets `golden` be tested without
a browser or a simulator. Only the PNGs directly in each directory count, so a README beside
the golden images, or a run's `golden-diff/`, is not compared. A name on one side only is
a difference, so a step a run gained or lost fails the comparison.

The comparison is [pixelmatch](https://github.com/mapbox/pixelmatch), with
[pngjs](https://github.com/pngjs/pngjs) to read and write the PNGs. Both are established
libraries for this job, and jest-image-snapshot uses them. A pixel differs when its colour
moves further than the threshold, an OKLab distance from 0 to 1 that is 0.1 by default.
pixelmatch also leaves out a pixel it reads as an anti-aliased edge, whose shade moves
between two renderings of one screen. An image differs when more pixels differ than
`--max-diff-pixels` allows, 0 by default. Two images of different sizes differ without a
pixel count.

Each difference writes a diff image into the run's `golden-diff/`. It is pixelmatch's
output, the golden image faded to grey with each differing pixel in red. For two sizes it
is the golden image and the run's side by side on grey. A comparison removes the diff
images of the one before it, so `golden-diff/` holds only the current differences.

Because a comparison clears `golden-diff/`, a golden directory that is `golden-diff/` or
lies in it is refused before anything is removed or written, and so is one that is the
run's own directory. Which directory a path names is read from the file system, by device
and inode, so a symbolic link, `..`, or a name that differs only in letter case on a
Mac's default volume does not hide it. A golden directory not made yet is refused when it would be made
there.

`--update` writes the run's new and changed images into the golden directory, removes the
golden images the run lacks, and leaves the matches alone. A screenshot that moved within
the tolerance therefore does not churn a committed file.

Names match as spelled, letter case included, so an image whose name changed only in
case is a new image and a missing one. The update removes before it writes. On a Mac's
default volume, writing `Board.png` first would write through `board.png`, and removing
`board.png` would then take the new image with it. A run that holds two images whose
names differ only in case is refused before anything changes, since they would be one
golden image on that volume.

`golden` exits 0 when every image matches or the update is written, 3 when something
differs, and 1 when nothing could be compared. That follows the captures, whose 3 means
the output was made but a check failed.

### A screenshot of each step for page and terminal scripts

`sprintshow screenshot --each-step` saves the state each step leaves, once its proof is
checked, as `<NN>-<caption>.png` in a new or empty directory. NN is padded to sort in
step order, and the caption is slugified and cut at a word to 48 characters. Each PNG is
the area the capture's options choose. A terminal script refuses `--full-page` with
`--each-step`, because growing the window to the session resizes the terminal the
following steps run in. A capture that fails at a later step removes the PNGs it wrote,
so exit 1 still means nothing was saved. A capture's output directory must be new or
empty, so it holds exactly one run's images when `golden` reads it.

## Measured on the host (macOS, Xcode 27.0, iOS 27.0 runtime, 2026-11-11)

With the bundled sample (`examples/sample-ios`), at a load average of about 15 to 35 on
18 cores:

- `build-for-testing` of the sample took 7 s.
- Creating a device took about 1 s, booting it about 19 s, a test pass 13 to 22 s, and
  deleting a booted device 4 s.
- A whole run took about 2 minutes: building, then two passes, each on a device of its
  own, with a video of each.
- A second run of the same build, on new devices, matched the first run's golden images
  with no pixel differing. So did two light passes on one device, byte for byte.
- A light and a dark screenshot of one step differed in 3.1 million of their 3.16 million
  pixels (1206x2622, an iPhone 17 Pro).
- `simctl privacy grant all <bundle>` succeeded before the app was installed.
- A failing test made `xcodebuild` exit 65, and the result bundle's summary gave its
  message.
- A variable set in the run's environment as `TEST_RUNNER_SPRINTSHOW_PROBE` reached the
  UI test as `SPRINTSHOW_PROBE`, as `man xcodebuild` documents for `TEST_RUNNER_<VAR>`.
- The capture test of an app outside this repository, run with `--grant` for that app's
  bundle identifier, passed in light and dark and saved its five checkpoints in each, ten
  screenshots, in about four minutes.
