---
name: sprintshow product goals
description: What sprintshow is for, whom it serves, and the goals a change to it is judged against. Read it to tell whether a change is the right thing to ship.
---

# sprintshow product goals

sprintshow records demos. For an app, its caller hands it an endpoint and a script, and
sprintshow drives the app there and records the demo, whether the app is a website or an
iOS app.

## Scope

This document states what sprintshow is for: the problem it solves, whom it serves, and
how to judge whether a change serves them. It leaves these topics to the docs that hold
them:

- How the engine is built, its parts and the rules they share:
  [architecture.md](architecture.md).
- Writing a demo script and running each command: [README.md](../README.md).
- Work planned or under way toward these goals: the repository's beads.

## Whom it serves

sprintshow serves whoever needs a demo recorded. That caller hands it the script, and for
an app, the endpoint.

The app's own repository is responsible for the app. It keeps the app's golden images. It
runs what the app needs, such as a simulator, and makes that available to its consumers,
sprintshow among them.

## How a change is judged

A change is judged against these goals.

- **Demos, not golden images.** sprintshow is not a golden images tool. It keeps no golden
  images, which are the app's repository's to keep.
- **No infrastructure for the app.** sprintshow is given an app that is up, or the command
  that brings it up. The app's repository names that command, for an iOS app as for a web
  app, and sprintshow only starts it and stops it around one capture. sprintshow builds
  and provisions nothing for the app.
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
- **Richer videos and lighter ones.** sprintshow should be able to make richer videos and
  lighter-weight videos.
