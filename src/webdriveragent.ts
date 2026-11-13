// The runner app that Appium's XCUITest driver installs on a device and drives an iOS app
// through: WebDriverAgent, which the appium-webdriveragent package ships as an Xcode
// project.
//
// It is a provisioned binary. `npm run provision:webdriveragent` builds it once with the
// host's Xcode, for any iOS Simulator device, into the user's cache, where every run
// finds it (runnerApp). A build is kept for each WebDriverAgent version and Xcode build,
// so updating either asks for a new one, and a run that finds none fails with the command
// that builds it. It is built with the bundle identifier RUNNER_BUNDLE_ID, so a run tells
// its own runner app from one that another tool installed on the device.
//
// xcodebuild runs with the engine's environment less the keys the engine holds (toolEnv).
// Run as a script, this module builds the runner app.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runTool, toolEnv } from './simulator.ts';

/** The bundle identifier the runner app is built with. */
export const RUNNER_BUNDLE_ID = 'com.zookanalytics.sprintshow.WebDriverAgentRunner';
/** The bundle identifier the runner app is installed under: Xcode adds `.xctrunner` to a UI test runner's. */
export const RUNNER_APP_ID = `${RUNNER_BUNDLE_ID}.xctrunner`;
/** The bundle name every WebDriverAgent runner app has, whoever built it. */
export const RUNNER_BUNDLE_NAME = 'WebDriverAgentRunner-Runner';
/** The command that builds the runner app. */
export const PROVISION_COMMAND = 'npm run provision:webdriveragent';

/** Where the runner app sits in a build's derived data. */
const RUNNER_PRODUCT = path.join('Build', 'Products', 'Debug-iphonesimulator', `${RUNNER_BUNDLE_NAME}.app`);

const requireHere = createRequire(import.meta.url);

/** The appium-webdriveragent package the XCUITest driver depends on, which holds WebDriverAgent's Xcode project. */
function webDriverAgentPackage(): { dir: string; version: string } {
  const driver = requireHere.resolve('appium-xcuitest-driver/package.json');
  const pkg = createRequire(driver).resolve('appium-webdriveragent/package.json');
  return { dir: path.dirname(pkg), version: (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version };
}

/** The build version of the host's Xcode, such as `27A266a`. */
async function xcodeBuild(): Promise<string> {
  const out = await runTool('xcodebuild', ['-version']);
  const build = out.match(/Build version\s+(\S+)/)?.[1];
  if (!build) throw new Error(`webdriveragent: xcodebuild -version printed no build version: ${out.trim().split('\n')[0]}`);
  return build;
}

/** The directory every build of the runner app is kept in. */
export function runnerCache(): string {
  return path.join(homedir(), 'Library', 'Caches', 'sprintshow', 'webdriveragent');
}

/** The derived data of the runner app's build for this WebDriverAgent version and this Xcode. */
async function buildDir(): Promise<{ dir: string; version: string; xcode: string }> {
  const { version } = webDriverAgentPackage();
  const xcode = await xcodeBuild();
  return { dir: path.join(runnerCache(), `${version}-xcode-${xcode}`), version, xcode };
}

/** The runner app built for this WebDriverAgent version and this Xcode. Throws, naming the command that builds it, when there is none. */
export async function runnerApp(): Promise<string> {
  const { dir, version, xcode } = await buildDir();
  const app = path.join(dir, RUNNER_PRODUCT);
  if (!existsSync(app)) {
    throw new Error(`webdriveragent: the runner app Appium installs on the device is not built for WebDriverAgent ${version} and Xcode ${xcode}; build it once with \`${PROVISION_COMMAND}\``);
  }
  return app;
}

/**
 * Build the runner app for this WebDriverAgent version and this Xcode, unless it is built.
 * It is built into a directory of its own beside the cache's builds and moved into place
 * once it is whole, so a build that fails or is stopped leaves no runner app behind, and
 * only its products are kept. Resolves with the runner app.
 */
export async function provisionRunnerApp(log: (m: string) => void = (m) => console.log(m)): Promise<string> {
  const { dir, version, xcode } = await buildDir();
  const app = path.join(dir, RUNNER_PRODUCT);
  if (existsSync(app)) {
    log(`webdriveragent: the runner app for WebDriverAgent ${version} and Xcode ${xcode} is built: ${app}`);
    return app;
  }
  mkdirSync(runnerCache(), { recursive: true });
  const work = mkdtempSync(path.join(runnerCache(), '.build-'));
  try {
    log(`webdriveragent: building the runner app for WebDriverAgent ${version} with Xcode ${xcode}…`);
    const project = path.join(webDriverAgentPackage().dir, 'WebDriverAgent.xcodeproj');
    const args = [
      'build-for-testing',
      '-project', project,
      '-scheme', 'WebDriverAgentRunner',
      '-destination', 'generic/platform=iOS Simulator',
      '-derivedDataPath', path.join(work, 'derived'),
      '-quiet',
      'CODE_SIGNING_ALLOWED=NO',
      `PRODUCT_BUNDLE_IDENTIFIER=${RUNNER_BUNDLE_ID}`,
    ];
    const status = await new Promise<number>((resolve, reject) => {
      const child = spawn('xcodebuild', args, { env: toolEnv(), stdio: ['ignore', 'inherit', 'inherit'] });
      child.on('error', reject);
      child.on('exit', (code, signal) => resolve(signal ? 128 : (code ?? 1)));
    });
    if (status !== 0) throw new Error(`webdriveragent: xcodebuild exited ${status} building the runner app`);
    if (!existsSync(path.join(work, 'derived', RUNNER_PRODUCT))) throw new Error('webdriveragent: xcodebuild succeeded but left no runner app');
    mkdirSync(path.join(work, 'kept', 'Build'), { recursive: true });
    renameSync(path.join(work, 'derived', 'Build', 'Products'), path.join(work, 'kept', 'Build', 'Products'));
    rmSync(dir, { recursive: true, force: true });
    renameSync(path.join(work, 'kept'), dir);
    log(`webdriveragent: built ${app}`);
    return app;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  provisionRunnerApp().catch((e: Error) => {
    console.error(`✖ ${e.message}`);
    process.exitCode = 1;
  });
}
