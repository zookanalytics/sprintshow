---
name: sprintshow product goals
description: What sprintshow is for, whom it serves, and the goals a change to it is judged against. Read it to tell whether a change is the right thing to ship.
---

# sprintshow product goals

sprintshow shows whoever receives work what changed, in a showcase anyone can follow,
without their loading the app or reading through the changes. A showcase is what a demo
script produces. The [README](../README.md) opens with sprintshow's press release, which
its owner approved, and this document says the same in detail. It states goals, so some of
what it describes is not built, and the README says which.

## Scope

This document states what sprintshow is for: the problem it solves, whom it serves, and
how to judge whether a change serves them. It leaves these topics to the docs that hold
them:

- How the engine is built, its parts and the rules they share:
  [architecture.md](architecture.md).
- Writing a demo script and running each command: [README.md](../README.md).
- Work planned or under way toward these goals: the repository's beads.

## Whom it serves

sprintshow serves whoever receives work and needs to see what was done: a reviewer, or the
next agent. Agents make the showcase. The main use is an agent that makes one at the end of
a piece of work, with nobody asking. The other is a person who wants something larger and
tells an agent what to look for. The agent that makes a showcase is not always the one that
did the work.

The app's own repository is responsible for the app. It keeps the app's golden images. It
runs what the app needs, such as a simulator, and makes that available to its consumers,
sprintshow among them.

## How a change is judged

A change is judged against these goals.

- **A showcase shows what changed.** It makes clear what the work changed, in the form the
  work calls for: a walkthrough, a before and after, or the changed screens called out. A
  reader who did not do the work can say from the showcase alone what was done. A change
  to sprintshow that leaves a showcase less able to show what changed fails this goal.
- **The know-how ships with sprintshow.** Everything an agent needs to turn what should be
  shown into a demo script and a showcase comes with the package, for whichever agent a
  team uses. A recorder that only takes a script is not the product.
- **Checks, and no verdict.** A step can carry a check of what the work was meant to do.
  sprintshow calls out where what was built parts from what was intended, and sets apart
  anything that turned up unplanned. It gives no verdict. It passes or fails no change, and
  the call is a person's. The checks are there so that what is shown is real.
- **sprintshow works with what the repository already runs.** Nothing is retooled for
  sprintshow. It shows an app in a browser, a terminal or an iOS simulator, running locally
  or at a preview URL.
- **sprintshow is told where to go.** A file in the repository says what sprintshow starts
  and where it looks, the same way on every run, and a run works none of that out for
  itself. Setting that file up is easy, and is a step of its own. The file is not a
  sandbox. It is there so that sprintshow knows where to go.
- **What comes back is for whoever comes next.** A run hands back the video, a picture of
  each step and a picture of each failed check, for a reviewer or for the next agent.
- **Golden images are the repository's.** sprintshow makes, updates, approves and keeps no
  golden images. It can show a picture the repository already keeps, such as a screenshot
  its tests take, as it shows a capture of the running app, and a viewer can tell the kept
  picture from one the run captured.
- **No infrastructure for the app.** sprintshow consumes the repository's stack as it is.
  It starts and stops what the repository names, which can include the repository's own
  build command, and it has no logic of its own to build, install or provision the app.
  Its interface to the repository's stack stays light.
- **sprintshow drives the app.** sprintshow has a UI driver for the app, as Playwright is a
  UI driver for a web page. It drives and engages with the app from the script, through
  whichever tool it prefers.
- **One interface for every kind of app.** sprintshow's interface does not differ with the
  type of application. Where it needs to, it can support more than one way of expressing
  the same thing, but no arbitrary difference between types.
- **What an app accepts is the app's to check.** sprintshow does not know one app's URL
  format, such as the scenario names it takes. A scenario name the app does not have is
  the app's to catch.
- **Self-contained, where it can be.** sprintshow brings the driver it drives an app with,
  rather than leaving the host to install it.
- **A showcase is as large as the work.** It can cover one change, a major feature, or a
  recap of many changes. Being short is not a goal. sprintshow can make richer videos and
  lighter ones.
