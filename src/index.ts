// Public library API for @zookanalytics/sprintshow.
//
// The CLI (`sprintshow run|screenshot|assemble|lint|provision`) is one consumer of this
// surface; the same functions are importable for the seed-test bootstrap (hand
// `captureProof` or `captureScreenshot` a ready page) and for embedding the engine in
// another tool.

// The demo-script grammar: parser, types, and slug helpers.
export * from './demo-script.ts';

// Assembly (frames → mp4) and its manifest types — the agent/MCP `assemble` entrypoint.
export { assembleVideo, baseDuration, type Frame, type Manifest, type AssembleOptions, type AssembleResult } from './assemble.ts';

// The drivers and their result types.
export { captureProof, type CaptureProofOptions, type CaptureResult } from './capture.ts';
export { captureWalkthrough, type CaptureWalkthroughOptions } from './walkthrough.ts';
export { captureScreenshot, captureScreenshots, stepFileName, type CaptureScreenshotOptions, type CaptureScreenshotsOptions, type ScreenshotResult, type ScreenshotsResult } from './screenshot.ts';

// The one-command orchestrators behind `sprintshow run` and `sprintshow screenshot`.
export { runDemo, runScreenshot, type RunDemoOptions, type RunResult, type RunScreenshotOptions, type CaptureMode } from './run.ts';

// The linter core + CLI.
export { lintDemo, lintCli, looksLikeDirective, looksLikeAssertion, outputPathFor, type Finding, type Severity, type LintEnv } from './lint.ts';

// The server seam, and the app an iOS app script drives.
export { ensureServer, ensureIosApp, DEFAULT_PORT, type ServeOptions, type ServerHandle } from './server.ts';
export { parseSimulatorUrl, simulatorUrl, SIMULATOR_URL_FORM, type SimulatorApp } from './simulator.ts';

// The runner app Appium installs on an iOS app's device, which
// `sprintshow provision webdriveragent` builds.
export { provisionRunnerApp } from './webdriveragent.ts';

// Browser primitives for the seed-test bootstrap and custom drivers. A custom driver that
// runs its steps through `runStep` checks each proof as the built-in captures do, and one
// that brings its script up with `openSurface` drives a terminal or iOS app script as they
// do. A page made with `contextOptions` is the device the script names, as theirs is.
export { installPointer, glideAndClick, glideAndType, glideTo, runAction, runStep, checkAssertion, awaitAssertion, chromiumLaunchArgs, connectSurface, openSurface, contextOptions, videoFrame, VIEWPORT, type StepProof, type Surface, type SurfaceConnection, type OpenSurfaceOptions } from './browser.ts';

// ffmpeg plumbing, for callers assembling audio themselves.
export { ffmpegBin, probeDuration, buildNarration, mixMusicBed, type NarrationSegment, type NarrationTrack } from './ffmpeg.ts';
