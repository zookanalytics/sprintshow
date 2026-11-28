---
name: A --base-url run that restarted its device — what ss-wvcd6 found
description: Why an iOS app run through --base-url could leave the app in a new process though every proof held, the evidence that Appium's XCUITest driver restarted the device, how the failure was reproduced on demand, and the design that tells the driver whether the host's Simulator UI runs. It also records the case the design leaves open and the designs weighed against it.
---

# A --base-url run that restarted its device

The live test of `--base-url` in `test/ios-live.test.ts` failed its last check on
2026-11-28 at origin/main 00b6093, in a full suite at a load average of about 43. After the
run, the app ran in a new process, 87760, where it had run in 66101. Every other check
held: the run exited 0, every step's proof held, the video and the PNGs checked out, the
appearance and status bar were put back, and the runner app was removed. The same check
had failed once before, on 2026-11-14.

## What happened to the device

The device restarted during the run, before its first step.

- CoreSimulator keeps a device's log folder after the device is deleted. In the failing
  device's folder, its syslogd first started at 00:23:34Z, when the test booted it, and a
  second syslogd started at 00:24:23Z. Its installer logged "Reboot detected" twice, from
  two processes, at 00:23:39Z and at 00:24:30Z. The app was installed at 00:24:04Z, before
  the second boot, and the runner app at 00:24:30Z to 00:24:34Z, after it.
- At 00:24:22Z the host's CoreSimulator log shows the IO set-up it logs when a device
  boots, and no device was created then.
- DeviceHub, Xcode 27's Simulator UI, started at 00:24:22Z. That process was still the
  host's DeviceHub an hour later.

Of the device folders the host keeps, 8 of 404 show a second syslogd within one boot.
Four of them restarted between 07:41Z and 07:55Z on 2026-11-14, the day the check first
failed.

## Why it restarted

Appium's XCUITest driver 12.22.8 starts each session on a simulator by calling `run` in
appium-ios-simulator 10.10.0, the version the driver pins (`startSim` in
`build/lib/commands/simulator.js`). It passes `isHeadless`, which is false unless the
capability sets it. `run` (`build/lib/extensions/ui-client.js`) makes a booted device match
it:

| `isHeadless` | The Simulator UI | What `run` does |
|---|---|---|
| false | runs | Nothing. |
| false | does not run | Shuts the device down, opens the UI with `open -Fn`, and boots the device again. |
| true | does not run | Nothing. |
| true | runs | Quits the UI with an Apple Event, through `osascript`. Boots the device again if it shuts down within 5 s. |

The UI is the app of the active Xcode with DeviceHub's bundle identifier,
`com.apple.dt.Devices`, among the apps beside the developer directory, from Xcode 27 on.
Before Xcode 27 it is the app with Simulator's, `com.apple.iphonesimulator`, among the apps
inside it. The driver reads Xcode's version from the `Info.plist` beside the developer
directory, which is `DEVELOPER_DIR` when it is set and the one `xcode-select` names
otherwise. It counts the UI as running when `pgrep -f` finds a process whose command line
holds the app's path.

The engine set no `isHeadless`. So a session that started while DeviceHub did not run shut
the device down, which ended the app, opened DeviceHub, and booted the device again. The
session then installed the runner app on the new boot. `mobile: activateApp` launched the
app, which no longer ran, with no arguments. The board starts empty, so step 1's proof held
as it would have on the app the caller launched.

DeviceHub, once open, keeps running whether or not a device is booted, so every run after
the one that opened it finds it running. A run restarted its device only after DeviceHub
had been quit, or before anything had opened it. That is why the check failed so seldom.

## Reproduced

With DeviceHub running, 17 runs of `demos/ios.md` through `--base-url` kept the app's
process. They started at load averages of about 140 to 970. Ten ran on one device, and
seven each on a device created and booted for it, as the test's is. They used the default
walkthrough mode with `--screenshots`.

The host's DeviceHub was left running. To make the driver find no UI, a run was given a
`DEVELOPER_DIR` naming a copy of Xcode's folder. Each part of the copy is a link to the
real Xcode's, and each app in its `Applications` folder is a link to the real app, so the
UI app's path differs from the path DeviceHub runs from. The run's `PATH` led with an `open`
that opens nothing, so a run that restarted its device opened no second DeviceHub.

- At 00b6093 the run failed as the test had. It exited 0 and all six proofs held, but the
  app ran in a new process and the device's `launchd_sim` was a new process. The driver ran
  `open -Fn` on the copy's DeviceHub, and the session took 56 s to start.
- With the fix, the same run kept the app's process and the device's `launchd_sim`, and ran
  no `open`. Its session started in about 5 s. It did the same with a stand-in process
  running from the copy's DeviceHub path, which the driver counts as the UI running.

## The design

Just before it starts a session, the engine reads whether the host's Simulator UI runs, as
the driver reads it (`simulatorUiRuns` in `src/simulator.ts`). It passes the opposite as
`appium:isHeadless`. Told what runs, the driver neither restarts the device nor quits the
UI, and the engine never opens or quits the UI itself.

The live test of `--base-url` runs with the copy of Xcode's folder and the `open` that
opens nothing, so it covers the case that failed on every run. Before, it covered that case
only on a host where DeviceHub was not running.

### What it leaves open

The driver reads the UI again when the session starts, a few seconds later. If the UI quits
in between, the device is still restarted. If the UI opens in between, the driver quits it.
No capability tells the driver to leave a booted device as it stands. That check belongs to
the driver, which the engine pins and does not patch, and the UI it reads is state other
processes on the host change. The gap in the driver is recorded as an upstream finding,
ss-am0la.

### Weighed

- **Always passing `isHeadless: true`.** The driver would then quit a DeviceHub that runs.
  It quits it with an Apple Event, which needs the Automation permission, and it boots the
  device again if quitting the UI shuts the device down.
- **Opening the UI before the session when it does not run.** The engine would open a
  window on the caller's host. A UI that quit in the seconds before the driver's check would
  still restart the device.
- **Bringing the app to the front with `simctl launch` instead of `mobile: activateApp`.**
  `simctl launch` keeps a running app's process: measured from the front and from the
  background, the pid did not change. But the app had already ended before the activate, so
  this does not help.
- **Checking after the session starts that the app kept its process, and failing the run
  when it did not.** That would catch the case the design leaves open. The engine has no
  reading of the app's process today, so this would add one. The cost is a second
  mechanism, for a window of a few seconds against a UI that quits only when a person or a
  crash ends it.
