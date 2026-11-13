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
its extensions from there. appium 3.9 and appium-xcuitest-driver 12.22 are dependencies.
12.x is the newest driver line that runs on the stable Appium, because 13.x needs Appium
4's beta.

The client is a thin layer over fetch, speaking the W3C WebDriver protocol and Appium's
extensions. WebdriverIO's clients, `webdriver` 9 and 10, need Node 22.23.4 or later on
the 22 line, above the engine's floor of 22.18, which CI runs. The engine sends a dozen
commands.

### The runner app is provisioned, with a bundle identifier of its own

WebDriverAgent's runner app is built once with `xcodebuild build-for-testing` for any
simulator, by `npm run provision:webdriveragent`. It goes into
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
standard output, not standard error, and reads only whole lines, so a URL cut between two
writes is never taken for a shorter one. The command has ten minutes to print it, because
building an app and booting a device take minutes. On SIGTERM it stops the app and deletes
its device, which sprintshow waits a minute for. `--port` and `--serve-dir` are refused.

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
