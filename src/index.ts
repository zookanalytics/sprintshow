// Public library API for @zookanalytics/sprintshow.
//
// The CLI (`sprintshow run|assemble|lint`) is one consumer of this surface; the same
// functions are importable for the seed-test bootstrap (hand `captureProof` a ready page)
// and for embedding the engine in another tool.

// The demo-script grammar: parser, types, and slug helpers.
export * from './demo-script.ts';

// Assembly (frames → mp4) and its manifest types — the agent/MCP `assemble` entrypoint.
export { assembleVideo, baseDuration, type Frame, type Manifest, type AssembleOptions, type AssembleResult } from './assemble.ts';

// The two drivers and the shared result type.
export { captureProof, type CaptureProofOptions, type CaptureResult } from './capture.ts';
export { captureWalkthrough, type CaptureWalkthroughOptions } from './walkthrough.ts';

// The one-command orchestrator behind `sprintshow run`.
export { runDemo, type RunDemoOptions, type CaptureMode } from './run.ts';

// The linter core + CLI.
export { lintDemo, lintCli, demoScenarioOf, looksLikeDirective, looksLikeAssertion, outputPathFor, type Finding, type Severity, type LintEnv } from './lint.ts';

// The server seam.
export { ensureServer, DEFAULT_PORT, type ServeOptions, type ServerHandle } from './server.ts';

// Browser primitives for the seed-test bootstrap and custom drivers.
export { installPointer, glideAndClick, glideAndType, glideTo, runAction, checkAssertion, awaitAssertion, chromiumLaunchArgs, VIEWPORT } from './browser.ts';

// ffmpeg plumbing, for callers assembling audio themselves.
export { ffmpegBin, probeDuration, buildNarration, mixMusicBed, type NarrationSegment, type NarrationTrack } from './ffmpeg.ts';
