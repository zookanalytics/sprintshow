// The simulator an iOS app script drives, as the engine finds it and as it leaves it.
//
// An iOS app is named by its simulator URL, `ios-simulator://<device UDID>/<bundle id>`:
// the app with that bundle identifier, on the iOS Simulator device with that UDID.
// `--base-url` takes the URL of an app already running on a booted device, and a `--serve`
// command prints it on its standard output once its app is up (server.ts).
//
// The engine never builds, installs, launches or removes the app, and never creates,
// boots, shuts down, erases or deletes a device: its caller does. For a run, the engine
// sets the device's appearance to light, the scheme Playwright shows a page in, and gives
// a status bar that carries no override of its own the fixed one of a product shot: 9:41,
// full signal and a charged battery. When the run ends it puts back what it changed
// (dressDevice).
//
// Every simctl the engine runs gets the engine's environment less the keys the engine
// holds (toolEnv), and so does Appium, with everything it starts (appium.ts), and a
// `--serve` command for an iOS app. So no key reaches xcrun, xcodebuild, Appium or
// WebDriverAgent, nor a log they write.

import { execFile } from 'node:child_process';

import { VERCEL_BYPASS_VAR } from './vercel.ts';

/** How a simulator URL is written, for a message that asks for one. */
export const SIMULATOR_URL_FORM = 'ios-simulator://<device UDID>/<bundle id>';

/** An app on an iOS Simulator device, as its simulator URL names it. */
export interface SimulatorApp {
  /** The device's UDID, in capitals as simctl prints it. */
  udid: string;
  /** The app's bundle identifier. */
  bundleId: string;
}

/** A device's UDID, as simctl prints it. */
const UDID_FORM = '[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}';
/** A bundle identifier: letters, digits and hyphens, in parts joined by dots. */
const BUNDLE_ID_FORM = '[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*';
const UDID = new RegExp(`^${UDID_FORM}$`, 'i');
const BUNDLE_ID = new RegExp(`^${BUNDLE_ID_FORM}$`);
const SIMULATOR_URL = /^ios-simulator:\/\/([^/]+)\/([^/?#]+)\/?$/i;
/**
 * A simulator URL among other text: its UDID and its bundle identifier, and what follows
 * them is not more of a URL, a path, a query, a fragment or more of a word.
 */
const SIMULATOR_URL_IN_TEXT = new RegExp(`ios-simulator://(${UDID_FORM})/(${BUNDLE_ID_FORM})/?(?![\\w/?#-]|\\.[\\w-])`, 'i');

/** Whether `url` is written in the simulator URL's scheme, so a page script refuses it and an iOS app script reads it. */
export function isSimulatorUrl(url: string): boolean {
  return /^ios-simulator:/i.test(url.trim());
}

/** The app a simulator URL names, or null when `url` is not one. */
export function parseSimulatorUrl(url: string): SimulatorApp | null {
  const m = url.trim().match(SIMULATOR_URL);
  if (!m || !UDID.test(m[1]) || !BUNDLE_ID.test(m[2])) return null;
  return { udid: m[1].toUpperCase(), bundleId: m[2] };
}

/**
 * The app the first simulator URL in `text` names, or null when `text` holds none. The URL
 * can sit among other text, such as at the end of a sentence or in a JSON string, so it
 * ends with its bundle identifier, and a URL that goes on past it, into a path, a query or
 * a fragment, names no app, as it does not for parseSimulatorUrl.
 */
export function findSimulatorUrl(text: string): SimulatorApp | null {
  const m = SIMULATOR_URL_IN_TEXT.exec(text);
  return m ? { udid: m[1].toUpperCase(), bundleId: m[2] } : null;
}

/** The simulator URL of `app`. */
export function simulatorUrl(app: SimulatorApp): string {
  return `ios-simulator://${app.udid}/${app.bundleId}`;
}

/**
 * The keys the engine holds: the Vercel bypass key, which only the engine uses, and the
 * speech key, which voices the narration. No tool the engine starts for an iOS app needs
 * either.
 */
const ENGINE_KEYS = [VERCEL_BYPASS_VAR, 'OPENAI_API_KEY'];

/** The environment of a tool the engine starts for an iOS app: the engine's own, less the keys the engine holds. */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !ENGINE_KEYS.includes(k)) env[k] = v;
  return env;
}

/** How long one simctl command has. Most take under a second; installing and removing an app take a few. */
const SIMCTL_TIMEOUT_MS = 60_000;

/** Run `command` with `args` in the tools' environment, and resolve with its standard output. */
export function runTool(command: string, args: string[], opts: { input?: string; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env: toolEnv(), timeout: opts.timeout ?? SIMCTL_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return reject(new Error(`${command} is not on PATH; an iOS app script needs macOS with Xcode and an iOS Simulator runtime`));
      }
      const why = String(stderr).trim().split('\n').filter(Boolean).pop() ?? err.message.split('\n')[0];
      reject(new Error(`${[command, ...args.slice(0, 2)].join(' ')}: ${why}`));
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Run `xcrun simctl <args>`, and resolve with its standard output. */
export function simctl(args: string[], input?: string): Promise<string> {
  return runTool('xcrun', ['simctl', ...args], { input });
}

interface SimDevice {
  udid: string;
  name: string;
  state: string;
}

/**
 * Throw unless `app`'s device is a booted iOS Simulator device with the app installed.
 * Resolves with the device's name.
 */
export async function checkApp(app: SimulatorApp): Promise<string> {
  const list = JSON.parse(await simctl(['list', 'devices', '--json'])) as { devices: Record<string, SimDevice[]> };
  const found = Object.entries(list.devices).flatMap(([runtime, devices]) => devices.map((d) => ({ runtime, ...d }))).find((d) => d.udid.toUpperCase() === app.udid);
  if (!found) throw new Error(`simulator: this host has no iOS Simulator device ${app.udid}`);
  const device = `${found.name} (${app.udid})`;
  if (!/\.iOS-/.test(found.runtime)) throw new Error(`simulator: ${device} is not an iOS device`);
  if (found.state !== 'Booted') throw new Error(`simulator: ${device} is ${found.state.toLowerCase()}; an iOS app script drives an app on a booted device, which its caller boots`);
  try {
    await simctl(['get_app_container', app.udid, app.bundleId]);
  } catch {
    throw new Error(`simulator: ${device} has no app ${app.bundleId}; its caller installs the app`);
  }
  return found.name;
}

/** The apps a user installed on device `udid`, each by its bundle identifier, with its bundle name. */
export async function userApps(udid: string): Promise<{ bundleId: string; name: string }[]> {
  // simctl prints the list as an old-style property list, which plutil turns into JSON.
  const json = await runTool('plutil', ['-convert', 'json', '-o', '-', '-'], { input: await simctl(['listapps', udid]) });
  const apps = JSON.parse(json) as Record<string, { ApplicationType?: string; CFBundleName?: string }>;
  return Object.entries(apps)
    .filter(([, a]) => a.ApplicationType === 'User')
    .map(([bundleId, a]) => ({ bundleId, name: a.CFBundleName ?? '' }));
}

/** The status bar of a product shot: 9:41, full Wi-Fi and cellular signal, and a charged battery. */
const PRODUCT_STATUS_BAR = ['--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100'];

/** The overrides `simctl status_bar list` reports: the lines under its heading's rule. */
export function statusBarOverrides(listed: string): string[] {
  const lines = listed.split('\n');
  const rule = lines.findIndex((l) => /^=+\s*$/.test(l));
  return lines.slice(rule + 1).map((l) => l.trim()).filter(Boolean);
}

/**
 * Dress device `udid` for a run: a light appearance, and the status bar of a product shot
 * unless the device's carries an override of its own, which it keeps. Resolves with what
 * puts back what it changed, which logs a change it cannot undo and goes on.
 */
export async function dressDevice(udid: string, log: (m: string) => void): Promise<() => Promise<void>> {
  const undo: { what: string; run: () => Promise<unknown> }[] = [];
  const restore = async (): Promise<void> => {
    for (const step of undo.splice(0).reverse()) {
      try {
        await step.run();
      } catch (e) {
        log(`simulator: could not put back the ${step.what}: ${(e as Error).message}`);
      }
    }
  };
  try {
    const appearance = (await simctl(['ui', udid, 'appearance'])).trim();
    if (appearance === 'dark') {
      await simctl(['ui', udid, 'appearance', 'light']);
      undo.push({ what: 'dark appearance', run: () => simctl(['ui', udid, 'appearance', appearance]) });
    }
    if (statusBarOverrides(await simctl(['status_bar', udid, 'list'])).length === 0) {
      await simctl(['status_bar', udid, 'override', ...PRODUCT_STATUS_BAR]);
      undo.push({ what: 'status bar', run: () => simctl(['status_bar', udid, 'clear']) });
    } else {
      log('simulator: the status bar keeps the override the device was given');
    }
  } catch (e) {
    await restore();
    throw e;
  }
  return restore;
}
