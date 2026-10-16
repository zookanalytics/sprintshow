// Public library API for @zookanalytics/sprintshow.
//
// The CLI (`sprintshow run|screenshot|assemble|lint`) is one consumer of this surface; the
// same functions are importable for the seed-test bootstrap (hand `captureProof` or
// `captureScreenshot` a ready page) and for embedding the engine in another tool.

// The demo-script grammar: parser, types, and slug helpers.
export * from './demo-script.ts';

// Assembly (frames → mp4) and its manifest types — the agent/MCP `assemble` entrypoint.
export { assembleVideo, baseDuration, type Frame, type Manifest, type AssembleOptions, type AssembleResult } from './assemble.ts';

// The drivers and their result types.
export { captureProof, type CaptureProofOptions, type CaptureResult } from './capture.ts';
export { captureWalkthrough, type CaptureWalkthroughOptions } from './walkthrough.ts';
export { captureScreenshot, type CaptureScreenshotOptions, type ScreenshotResult } from './screenshot.ts';

// The one-command orchestrators behind `sprintshow run` and `sprintshow screenshot`.
export { runDemo, runScreenshot, type RunDemoOptions, type RunScreenshotOptions, type CaptureMode } from './run.ts';

// The linter core + CLI.
export { lintDemo, lintCli, demoScenarioOf, looksLikeDirective, looksLikeAssertion, outputPathFor, type Finding, type Severity, type LintEnv } from './lint.ts';

// The server seam.
export { ensureServer, DEFAULT_PORT, type ServeOptions, type ServerHandle } from './server.ts';

// Browser primitives for the seed-test bootstrap and custom drivers. A custom driver that
// runs its steps through `runStep` checks each proof as the built-in captures do.
export { installPointer, glideAndClick, glideAndType, glideTo, runAction, runStep, checkAssertion, awaitAssertion, chromiumLaunchArgs, VIEWPORT, type StepProof } from './browser.ts';

// ffmpeg plumbing, for callers assembling audio themselves.
export { ffmpegBin, probeDuration, buildNarration, mixMusicBed, type NarrationSegment, type NarrationTrack } from './ffmpeg.ts';
