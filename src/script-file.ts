// A demo script as a caller names one: the path of its file, or the demo already parsed.
// Whatever takes a script takes it this way, so a string always names a file to read and
// is never read as the script's markdown.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { parseDemoScript, type Demo } from './demo-script.ts';

/** The demo `script` names: the demo itself, or the script in the file at that path, resolved against the working directory. */
export function loadDemo(script: string | Demo): Demo {
  if (typeof script !== 'string') return script;
  const scriptPath = path.resolve(script);
  if (!existsSync(scriptPath)) throw new Error(`demo script not found: ${scriptPath}`);
  return parseDemoScript(readFileSync(scriptPath, 'utf8'));
}
