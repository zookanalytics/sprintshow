// The demo-script linter — the pre-flight that runs before a capture spends a browser
// and an encode. A script can parse and run yet capture nothing worth watching: pages
// shown without proving anything, a directive dropped for a typo, a caption too long to
// read. The linter reads a script exactly as the driver will and reports what the driver
// would silently do nothing about.
//
// PURE CORE, thin CLI — the same split as demo-script.ts: `lintDemo()` takes a parsed
// Demo plus an explicit environment snapshot and returns findings, so the rules are
// unit-tested (lint.test.ts) without git, a browser or a network.
//
// A script drives one surface, a page or a terminal, and the parser reads only that
// surface's directives and assertions. One written for the other surface is dropped as
// prose, so the linter names the surface it belongs to. A directive whose verb is its
// own surface's is dropped only when its arguments do not parse, and the linter says so.
//
// A device a page script names is checked against the device names in the environment,
// which the CLI reads from Playwright's registry, the one a capture looks it up in.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { devices } from 'playwright';

import { parseDemoScript, deviceName, unknownDevice, ACTION_VERBS, ASSERTION_KINDS, TERMINAL_VERBS, TERMINAL_ASSERTION_KINDS, VIEWPORT_SIZE_FORM, outputSlug, surfaceOf, type Demo, type SurfaceKind } from './demo-script.ts';

/** Step-count window from the demo-authoring contract: under 5 is thin, over 12 spans too much. */
const MIN_STEPS = 5;
const MAX_STEPS = 12;
/** A caption is one line on screen; past this it wraps or clips. */
const MAX_NARRATION = 80;

export type Severity = 'error' | 'warn' | 'info';

export interface Finding {
  severity: Severity;
  /** Step number the finding belongs to, or null for script-level findings. */
  step: number | null;
  message: string;
}

/** Everything outside the script that the rules need — passed in so the core stays pure. */
export interface LintEnv {
  /**
   * Known scenario values a `?demo=<scenario>` start URL may name, when the app arms
   * itself from that query. Empty (the default) turns the check off: a general app has
   * no such registry, and a caller that does can supply it.
   */
  scenarios: string[];
  /** `git lfs` available on this machine. */
  lfsInstalled: boolean;
  /** The MP4 this script would produce is matched by an LFS filter attribute. */
  lfsTracked: boolean;
  /** OPENAI_API_KEY present → the capture will narrate; absent → silent MP4. */
  narration: boolean;
  /** The device names a `**Device:**` line may name: those in the registry a capture looks a device up in. */
  devices: readonly string[];
}

/** The scenario named by a `?demo=` query, or null when the start URL has none. */
export function demoScenarioOf(start: string): string | null {
  const m = start.match(/[?&]demo=([^&#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Verbs that mean "I meant to drive the browser here". A dropped span is only worth
 * reporting when it looks like an attempted directive — prose legitimately cites
 * selectors (`#panel`), URLs (`?tab=`) and commands (`npm run dev`) in backticks, and
 * flagging those would bury the real finding. So: the real verbs (to catch case slips
 * like `waitfor`) plus the plausible-wrong ones an author reaches for out of Playwright
 * habit.
 */
const DIRECTIVE_WORDS = new Set([
  ...ACTION_VERBS.map((v) => v.toLowerCase()),
  ...TERMINAL_VERBS.map((v) => v.toLowerCase()),
  'waitforselector',
  'waitforelement',
  'waitfortext',
  'sleep',
  'pause',
  'fill',
  'hover',
  'select',
  'check',
  'navigate',
  'open',
  'screenshot',
  'expect',
  'assert',
  'scrollto',
  'scrollintoview',
]);

/** Each surface's directives and assertions, as a finding names them. */
const VOCABULARY: Record<SurfaceKind, { verbs: readonly string[]; assertions: readonly string[] }> = {
  page: { verbs: ACTION_VERBS, assertions: ASSERTION_KINDS },
  terminal: { verbs: TERMINAL_VERBS, assertions: TERMINAL_ASSERTION_KINDS },
};

/** What a directive's arguments lack, for each verb whose arguments parseAction can refuse. */
const ARGUMENTS: Record<string, string> = {
  run: 'it needs a command line',
  press: 'a quote is left open or sits inside a word, a string is empty, or there are no keys',
  waitForScreen: 'it needs a matcher',
  resize: `it needs a size, ${VIEWPORT_SIZE_FORM}`,
};

/** The verb a code span opens with, read as the parser reads it, when it is one of `surface`'s. */
function ownVerb(code: string, surface: SurfaceKind): string | null {
  const verb = code.trim().split(' ')[0];
  return VOCABULARY[surface].verbs.includes(verb) ? verb : null;
}

/** The surface a code span's lead word is a directive or an assertion of, when that is not `surface`. */
function otherSurface(code: string, surface: SurfaceKind, kind: 'verbs' | 'assertions'): SurfaceKind | null {
  const lead = leadWord(code);
  const has = (s: SurfaceKind): boolean => VOCABULARY[s][kind].some((w) => w.toLowerCase() === lead);
  const other: SurfaceKind = surface === 'page' ? 'terminal' : 'page';
  return has(other) && !has(surface) ? other : null;
}

/** First bare word of a code span, lowercased — '' when it does not start with one. */
function leadWord(code: string): string {
  const first = code.trim().split(/\s+/)[0] ?? '';
  return /^[A-Za-z]+$/.test(first) ? first.toLowerCase() : ''; // selectors, URLs, flags → prose
}

/** True when a dropped code span reads as an attempted directive rather than prose. */
export function looksLikeDirective(code: string): boolean {
  // An exact-case real verb never reaches here (it parsed); a case slip does.
  return DIRECTIVE_WORDS.has(leadWord(code));
}

/**
 * True when a code span on a `_Prove:_` / `_Fail if:_` line reads as an attempted
 * ASSERTION — e.g. `count #x` (missing its operator), `Visible #x`, or either surface's
 * assertion in a script of the other. Separate from the directive test because assertion
 * kinds are a different vocabulary from action verbs.
 */
export function looksLikeAssertion(code: string): boolean {
  const lead = leadWord(code);
  return [...ASSERTION_KINDS, ...TERMINAL_ASSERTION_KINDS].some((k) => k === lead) || DIRECTIVE_WORDS.has(lead);
}

/** Apply every rule to a parsed script. Order: script-level findings first, then per step. */
export function lintDemo(demo: Demo, env: LintEnv): Finding[] {
  const out: Finding[] = [];
  const add = (severity: Severity, step: number | null, message: string): void => {
    out.push({ severity, step, message });
  };

  // ── Substrate: does the demo actually interact with the page or the terminal? ──
  //
  // A demo that performs no action and opens on a bare path captures a still life. A
  // query on the start URL (an app that arms itself from one) or any step action counts
  // as interaction. A terminal has no start URL: only its steps' actions drive it.
  const surface = surfaceOf(demo);
  const { verbs, assertions } = VOCABULARY[surface];
  const scenario = demoScenarioOf(demo.start);
  const drivesByAction = demo.steps.some((s) => s.actions.length > 0);
  const hasQuery = demo.start.includes('?');
  if (surface === 'terminal') {
    if (!drivesByAction) {
      add('warn', null, `no step runs a command or presses a key — the capture shows the shell's first prompt and nothing else. Add actions (${verbs.join('/')}).`);
    }
    if (demo.start) add('warn', null, `**Start:** \`${demo.start}\` is ignored — a terminal script's shell starts in --cwd, not at a path.`);
  } else if (scenario && env.scenarios.length && !env.scenarios.includes(scenario)) {
    add(
      'error',
      null,
      `\`?demo=${scenario}\` is not a known scenario (have: ${env.scenarios.join(', ')}) — the app would open unarmed and every proof would fail.`,
    );
  } else if (!drivesByAction && !hasQuery) {
    add(
      'warn',
      null,
      `**Start:** \`${demo.start}\` has no query and no step performs an action — the capture opens the page and screenshots it without interacting. Add actions (goto/click/type/waitFor…) or a start query that arms the app.`,
    );
  }

  // ── Device: one the capture can emulate, on a surface that has one ──
  if (demo.device && surface === 'terminal') {
    add('warn', null, `**Device:** is ignored — a terminal script is filmed in the engine's own frame, and its size is its **Terminal:** columns and rows.`);
  } else if (demo.device && 'name' in demo.device && !deviceName(demo.device.name, env.devices)) {
    add('error', null, `${unknownDevice(demo.device.name, env.devices)} — the capture would refuse the script.`);
  }

  // ── Shape: the step-count window ──
  if (demo.steps.length < MIN_STEPS) {
    add('warn', null, `${demo.steps.length} steps — under ${MIN_STEPS}. Add context-setting steps, or fold this into another demo.`);
  } else if (demo.steps.length > MAX_STEPS) {
    add('warn', null, `${demo.steps.length} steps — over ${MAX_STEPS}. Split it, or narrow to the highest-impact behaviour.`);
  }

  // ── Per step ──
  for (const step of demo.steps) {
    if (step.narration.length > MAX_NARRATION) {
      add('warn', step.index, `caption is ${step.narration.length} chars (max ${MAX_NARRATION}) — it will wrap or clip on screen.`);
    }

    if (!step.prove) {
      add('warn', step.index, `no \`_Prove:_\` line — this step shows a screen without claiming anything about it.`);
    } else if (!step.prove.assertion) {
      const attempted = step.prove.codes.filter(looksLikeAssertion);
      const other = attempted.length ? otherSurface(attempted[0], surface, 'assertions') : null;
      add(
        'warn',
        step.index,
        attempted.length
          ? `\`_Prove:_\` carries \`${attempted[0]}\`, ${other ? `a ${other} assertion in a ${surface} script` : 'which is not a recognised assertion'} — the step is NOT checked. Assertions are ${assertions.join('/')}.`
          : `\`_Prove:_\` is prose only — nothing is checked against the ${surface}. Add an assertion (${assertions.map((k) => `\`${k}\``).join('/')}) to make the step a proof.`,
      );
    }
    if (step.failIf && !step.failIf.assertion) {
      add('warn', step.index, `\`_Fail if:_\` is prose only — the condition is never evaluated.`);
    }

    for (const code of step.droppedCodes.filter(looksLikeDirective)) {
      const own = ownVerb(code, surface);
      const other = otherSurface(code, surface, 'verbs');
      // A dropped resize leaves every step after it at the size before it, a layout the
      // script did not mean to show, so a size that does not parse is an error.
      if (own === 'resize' && code.trim() !== own) {
        add('error', step.index, `\`${code}\` does not name a size, ${VIEWPORT_SIZE_FORM} — it is IGNORED at capture time, and the steps after it run at the size before it.`);
        continue;
      }
      add(
        'warn',
        step.index,
        own
          ? `\`${code}\` has malformed arguments: ${ARGUMENTS[own] ?? 'they do not parse'} — it is IGNORED at capture time.`
          : `\`${code}\` ${other ? `is a ${other} directive in a ${surface} script` : 'is not a known directive'} — it is IGNORED at capture time (verbs: ${verbs.join(', ')}).`,
      );
    }

    // A row or column past the terminal's edge is one no screen has.
    if (demo.terminal) {
      for (const a of [step.prove?.assertion, step.failIf?.assertion]) {
        if (a?.row !== undefined && Math.abs(a.row) > demo.terminal.rows) {
          add('warn', step.index, `\`${a.raw}\` names row ${a.row}, past the terminal's ${demo.terminal.rows} rows — it never holds.`);
        }
        if (a?.col !== undefined && a.col > demo.terminal.cols) {
          add('warn', step.index, `\`${a.raw}\` names column ${a.col}, past the terminal's ${demo.terminal.cols} columns — it never holds.`);
        }
      }
    }
  }

  // ── Publishing: can the artifact this produces actually be committed? ──
  if (!env.lfsTracked) {
    add('warn', null, `the MP4 this script produces is not matched by an LFS filter in .gitattributes — committing it would put raw video bytes in git history.`);
  } else if (!env.lfsInstalled) {
    add(
      'warn',
      null,
      `git-lfs is NOT installed but .gitattributes claims LFS for this MP4 — a commit here silently stores the raw bytes. Install it first: git lfs install.`,
    );
  }

  add(
    'info',
    null,
    env.narration ? `OPENAI_API_KEY is set — the capture will narrate the MP4.` : `no OPENAI_API_KEY — the capture will produce a SILENT MP4 (narration is best-effort).`,
  );

  return out;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** The MP4 path a run would write for this script, by the shared derivation (script filename, slugified, under demos/). */
export function outputPathFor(scriptPath: string, outDir = path.join(process.cwd(), 'demos')): string {
  return path.join(outDir, `${outputSlug(path.basename(scriptPath, path.extname(scriptPath)))}.mp4`);
}

function gitOk(args: string[]): boolean {
  return spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' }).status === 0;
}

/** Does an LFS filter attribute apply to `file`? (`git check-attr filter -- <file>`) */
function lfsTracked(file: string): boolean {
  const r = spawnSync('git', ['check-attr', 'filter', '--', file], { cwd: process.cwd(), encoding: 'utf8' });
  return r.status === 0 && /filter:\s*lfs/.test(r.stdout ?? '');
}

/** Run the linter as a CLI over `scriptArg`; returns the process exit code. */
export function lintCli(scriptArg: string | undefined, strict: boolean): number {
  if (!scriptArg) {
    console.error('usage: sprintshow lint <demo-script.md> [--strict]');
    return 1;
  }
  const scriptPath = path.resolve(scriptArg);
  if (!existsSync(scriptPath)) {
    console.error(`demo script not found: ${scriptPath}`);
    return 1;
  }

  let demo: Demo;
  try {
    demo = parseDemoScript(readFileSync(scriptPath, 'utf8'));
  } catch (e) {
    // A parse failure is terminal: the driver would refuse the same file.
    console.error(`✖ ${path.relative(process.cwd(), scriptPath)} — ${(e as Error).message}`);
    return 1;
  }

  const out = outputPathFor(scriptPath);
  const findings = lintDemo(demo, {
    scenarios: [],
    lfsInstalled: gitOk(['lfs', 'version']),
    lfsTracked: lfsTracked(out),
    narration: Boolean(process.env.OPENAI_API_KEY),
    devices: Object.keys(devices),
  });

  console.log(`${path.relative(process.cwd(), scriptPath)} → ${path.relative(process.cwd(), out)}`);
  console.log(`"${demo.title}" — ${demo.steps.length} steps, ${demo.scrutiny.length} scrutiny item(s)`);
  console.log('');
  const mark = { error: '✖', warn: '⚠', info: 'ℹ' } as const;
  for (const f of findings) {
    console.log(`${mark[f.severity]} ${f.step === null ? 'script' : `step ${f.step}`}: ${f.message}`);
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warns = findings.filter((f) => f.severity === 'warn').length;
  console.log('');
  console.log(errors || warns ? `${errors} error(s), ${warns} warning(s)` : '✅ clean');
  return errors > 0 || (strict && warns > 0) ? 1 : 0;
}
