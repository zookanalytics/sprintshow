---
name: iOS app surface — what ss-rmvnx decided
description: The design ss-rmvnx settled for driving an iOS app on a running simulator through Appium, from the demo-script grammar and the options a web run takes, and for returning the video and screenshots a web run returns. It covers the driver, how an app is named and how a start command reports it is up, whether a run takes the app fresh, the gestures each action maps to, how a recording shows the device with captions and narration, what a run does to the device, and how keys stay out of the tools. It records what was measured on a macOS host with Xcode 27.
---

# The iOS app surface

A demo script that declares `**Platform:** iOS` drives an iOS app on an iOS Simulator
device through Appium's XCUITest driver. It is named through the options that name a web
app, and every capture takes it: the walkthrough, the proof video, a PNG of each step, and
`sprintshow screenshot`.

## Decisions

### Appium drives the app

The operator chose Appium. It was proved on the host first, on the sample app: a session
launched the app by bundle identifier on a booted device, tapped by identifier and by
label, typed, read text, and streamed and screenshotted the screen. AXe was the fallback,
and was not needed.

The engine runs Appium as a server of its own for each run rather than loading the driver
into its process. The driver runs simctl and xcodebuild, and those must not inherit the
engine's keys. A process of its own is the one place the environment they inherit can be
set. Its home is the directory whose node_modules holds the driver, because Appium reads
its extensions from there. The engine pins appium 3.9.0 and appium-xcuitest-driver
12.22.8. 12.x is the newest driver line that runs on the stable Appium, because 13.x needs
Appium 4's beta.

The client is a thin layer over fetch, speaking the W3C WebDriver protocol and Appium's
extensions. WebdriverIO's clients, `webdriver` 9 and 10, need Node 22.23.4 or later on
the 22 line, above the engine's floor of 22.18, which CI runs. The engine sends a dozen
commands.

### Appium is provisioned, not a dependency

Appium and its XCUITest driver are not dependencies of the package. As dependencies they
added 578 packages to the lockfile, 552 of which install on macOS, about 150 MB, and 18
moderate `npm audit` advisories, to every install, iOS or not. The operator asked for
"some other way of factoring it out for places that do not need it" (PR #17, review
5901847613).

`sprintshow provision appium` installs the two pinned versions with npm into
`~/Library/Caches/sprintshow/appium/<appium version>-xcuitest-<driver version>`, which is
Appium's home for every run, and then builds the runner app from the WebDriverAgent
project in that home. So one command sets a host up for iOS app demos, as
`provision:browser` sets one up for a page. npm installs them as it installs any project's
dependencies, under its own policy for install scripts, as it did when they were the
package's dependencies, into a directory of its own that is moved into place once whole.
The packages below the two pinned ones are the versions npm resolves when it installs
them, as they are for any project that installs the package, and a host keeps the tree it
installed. A run that finds no home fails with the command.

Two other ways were weighed:

- Optional peer dependencies. npm does not install an optional peer, so a web-only
  install would carry nothing. But a user who demos an iOS app would install both
  packages beside sprintshow and keep their versions in its range, and the checkout's
  own install, CI's included, would still carry them as development dependencies, since
  its live tests need them.
- Moving off Appium. AXe drives a simulator with no npm package, but it is a binary from
  a Homebrew tap, built on Apple's private accessibility APIs, and taking it means
  writing the surface's driver again. Driving WebDriverAgent directly means doing what the
  XCUITest driver does to install, launch and connect to the runner app.

### The runner app is provisioned, with a bundle identifier of its own

WebDriverAgent's runner app is built once with `xcodebuild build-for-testing` for any
simulator, by `sprintshow provision appium`, once it has installed Appium. A project that
installed sprintshow runs it with npx, and a checkout of sprintshow runs it with
`npm run provision:appium`. It is a command of the CLI because the published package
holds only the build, so a script that runs the source would fail wherever sprintshow is
installed. It goes into
`~/Library/Caches/sprintshow/webdriveragent/<WebDriverAgent version>-xcode-<Xcode build>`,
and only its products are kept. A run installs that build through the driver's
preinstalled mode (`usePreinstalledWDA` with `prebuiltWDAPath`), which launches the
installed runner without xcodebuild, and removes it when the run ends.

That mode removes every other WebDriverAgent runner app on the device, by bundle name,
before it installs its own. The runner is therefore built with the bundle identifier
`com.zookanalytics.sprintshow.WebDriverAgentRunner`. A run removes a runner of its own that
a stopped run left behind, and refuses a device that holds one another tool installed,
because the driver would remove it.

### How an app is named, and how a start command says it is up

The operator ruled that no option differs by kind of app. `--base-url` takes an app
already running, named by its simulator URL, `ios-simulator://<device UDID>/<bundle id>`.
That is the second way of expressing the option the bead allows. `--serve` takes the repo's
start command, which sprintshow starts, waits for and stops, as it does a dev server.

A web server says it is up by answering on the port `--port` names. An app on a simulator
has no port. Its command does not know the device's UDID until it has created the device,
so the caller cannot name it in advance. The command therefore prints the app's simulator
URL on a line of its standard output once the app is up. That line says the app is ready,
on which device and with which bundle, and any command can print it. sprintshow scans
standard output, not standard error, and reads only whole lines, a line ending at a
newline or at the end of the output, so a URL cut between two writes is never taken for a
shorter one. The URL can stand among other text on its line, as at the end of a sentence
or in a JSON log line: it ends with its bundle identifier, and one that goes on into a
path, a query or a fragment names no app. The command has ten minutes to print it, because
building an app and booting a device take minutes. On SIGTERM it stops the app and deletes
its device. sprintshow sends SIGTERM to the command's whole process group, waits until
every process in the group has exited, and kills what is left of it after a minute. It
waits for the group, not the command alone, because a command can leave the process that
holds the app running in the background and exit. A command that exits before it prints
the URL has its group stopped the same way. `--port` and `--serve-dir` are refused.

### A run takes the app as it stands

The session neither launches nor relaunches the app, and does not end it (`autoLaunch`,
`forceAppLaunch` and `shouldTerminateApp` off, `noReset` on). The engine brings the app to
the front, which launches it, with no arguments, only when it is not running. A start
command launches the app in the mode a capture needs, such as with launch arguments that
stand in for input a driver cannot give, and a relaunch would lose them.

### The gestures each action maps to

An iOS app script reads a page script's grammar, less what has no meaning on a device:
`goto`, `resize`, `focused` and `eval`. `focused` was tried. WebDriverAgent's `focused`
attribute is XCUITest's `hasFocus` (`XCUIElement+FBWebDriverAttributes.m`), and it stayed
false for a field that held the keyboard and took the typing.

| Action | Gesture |
|---|---|
| `click` | A tap on the element (W3C element click). |
| `type` | A tap on the field, a clear, and the text typed (element value). |
| `press` | Keys typed into the field with the keyboard's focus: Enter as a Return, Tab, Backspace and Space as their characters, and a quoted string as typed. Other keys have no iOS keyboard counterpart and are refused. |
| `scroll` | `mobile: scrollToElement`. |
| `waitFor`, `waitForText` | Polling the element's display state, its label and its value. |

A selector is Appium's `accessibility id`, which matches an element's name: its
accessibility identifier, or its label when it has none. An element's text is its label
and its value, so `text` holds when either matches, because XCUITest's own text is one or
the other.

### Captions and narration over the simulator's screen

The device's screen is shown in a page the engine writes, as the terminal is: a canvas
fitted to the stage above the caption band, which WebDriverAgent's MJPEG stream draws on,
at 25 frames a second and half the screen's pixels. So the walkthrough and proof drivers
film it as they film a page. Their captions, cards, narration timing, music and cuts are
the ones every surface has, and the pointer is drawn as a touch where a step taps.
Recording the device itself with `simctl io recordVideo` and laying the captions over it
was weighed. It would have meant a second video path with its own timeline, and the
architecture keeps text out of ffmpeg.

A step's PNG is the device's own screenshot, at the device's scale, which changes nothing
in the filmed page, so the walkthrough cuts nothing for it. `settle` sends an element
query, which WebDriverAgent answers once the app is idle, and then waits for a frame that
reached the engine after it.

`settle` throws when no such frame comes within 30 s, or once the stream has ended or the
page could not draw a frame. A capture then fails, rather than filming or saving a screen
the app has moved past while its proofs, which read the app through Appium, still hold.
WebDriverAgent sends a frame at every tick, and backs off at most 10 s after a screenshot
it fails to take, so a healthy stream comes well within the wait. Proof mode settles the
surface after each step, and the walkthrough settles an iOS app after each step, with or
without screenshots. Reconnecting to the stream once it ends was weighed. It would still
need the failure for a stream that does not come back, so a run fails at the first loss
instead, and can be run again.

A walkthrough connects to the app before it starts recording. A recording films a page
from its first frame, blank or not: a probe that waited 5 s before painting a page made a
9 s video.

### The device, as the run leaves it

For a run, the engine sets the appearance to light, the scheme Playwright shows a page in.
It gives a status bar that carries no override the one of a product shot: 9:41, full
signal, a charged battery. A status bar with an override of its own is left alone. When the
run ends, the engine puts back what it changed. These and every other simctl call, Appium,
xcodebuild and an iOS app's start command run with the engine's environment less
`VERCEL_AUTOMATION_BYPASS_SECRET` and `OPENAI_API_KEY`.

## Measured on the host (macOS 27, Xcode 27.0, iOS 27.0 runtime, 2026-11-13)

At a load average of about 15 to 80 on 18 cores:

- Building the runner app took 24 to 35 s, and its derived data was 217 MB, of which its
  products were 28 MB.
- A session that installed the runner app started in about 23 s the first time, and in
  about 4 s once the runner app had been installed before.
- With the session attached, the app kept its process (the same pid before and after), and
  kept running when the session ended.
- Typing 20 characters into a field took 0.7 s, a tap about 0.85 s, a screenshot 0.15 s,
  and a page source 1.2 s.
- The MJPEG stream gave about 20 frames a second at 25 asked for, 50 % scale and quality
  75, some 24 kB a frame.
- demos/ios.md ran in about 40 s through `--base-url`, and in about 80 s through
  `--serve`, whose command booted a device of its own. Every run left the device dark
  again, with no status bar override and no runner app, and with the app running in the
  same process.
