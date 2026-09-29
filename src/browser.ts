// Browser-driving primitives shared by both capture modes: the synthetic pointer and
// its human-paced glide helpers, the action runner that executes a parsed directive, and
// the assertion evaluator that checks a `_Prove:_` / `_Fail if:_` contract against the
// live DOM.
//
// The pointer is a DOM element the engine moves, so a click or a keystroke reads on
// screen in the walkthrough recording (a real Playwright click leaves no visible cursor).
// The still-frame path skips it and drives the page directly, for speed and determinism.

import type { Page } from 'playwright';
import type { Assertion, DemoAction } from './demo-script.ts';

export const VIEWPORT = { width: 1280, height: 900 };
export const ACTION_TIMEOUT = 15000; // per waitFor/waitForText/click/type
export const PROVE_TIMEOUT = 10000; // how long a `_Prove:_` assertion is polled before failing
const POLL_MS = 200;
const GLIDE_MS = 480; // pointer travel time; matches the CSS transition below
const TYPE_DELAY_MS = 55; // per keystroke in humanized typing

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function joinUrl(base: string, pathAndQuery: string): string {
  return base.replace(/\/$/, '') + (pathAndQuery.startsWith('/') ? '' : '/') + pathAndQuery;
}

/**
 * Chromium's setuid/namespace sandbox cannot start as root, so a rootful container has
 * to disable it. Localhost content on a dev box makes the practical risk low, but it is
 * still a real sandbox removal, so it is opt-in rather than unconditional:
 *
 *   uid 0            no sandbox is possible — drop it, or Chromium will not start
 *   PW_NO_SANDBOX=1  explicit opt-out where the sandbox cannot work (a container with
 *                    no CAP_SYS_ADMIN, a locked-down userns)
 *
 * Everywhere else the sandbox stays on.
 */
export function chromiumLaunchArgs(): string[] {
  const rootful = process.getuid?.() === 0;
  return rootful || process.env.PW_NO_SANDBOX === '1' ? ['--no-sandbox'] : [];
}

/** Init script (re-run on every navigation) that installs the pointer and its `window.__ss` API. */
const POINTER_INIT = `(() => {
  if (window.__ss_installed) return; window.__ss_installed = true;
  const build = () => {
    if (!document.body || document.getElementById('__ss_pointer__')) return;
    const style = document.createElement('style');
    style.textContent =
      '#__ss_pointer__{position:fixed;z-index:2147483646;width:24px;height:24px;margin:-3px 0 0 -3px;' +
      'pointer-events:none;left:50%;top:45%;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45));' +
      'transition:left ${GLIDE_MS}ms cubic-bezier(.22,.61,.36,1),top ${GLIDE_MS}ms cubic-bezier(.22,.61,.36,1);}' +
      '.__ss_ripple__{position:fixed;z-index:2147483645;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;' +
      'pointer-events:none;background:rgba(106,208,138,.55);animation:__ss_r .55s ease-out forwards}' +
      '@keyframes __ss_r{from{transform:scale(.3);opacity:.9}to{transform:scale(3.6);opacity:0}}';
    document.head.appendChild(style);
    const p = document.createElement('div');
    p.id = '__ss_pointer__';
    p.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' +
      '<path d="M3 2l7 18 2.9-7.4L20 9.7 3 2z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
    document.body.appendChild(p);
  };
  window.__ss = {
    moveTo(x, y) { build(); const el = document.getElementById('__ss_pointer__'); if (el) { el.style.left = x + 'px'; el.style.top = y + 'px'; } },
    ripple(x, y) { build(); const r = document.createElement('div'); r.className = '__ss_ripple__'; r.style.left = x + 'px'; r.style.top = y + 'px'; document.body.appendChild(r); setTimeout(() => r.remove(), 560); },
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})()`;

/** Register the pointer so every navigation re-installs it. Call once, before the first goto. */
export async function installPointer(page: Page): Promise<void> {
  await page.addInitScript(POINTER_INIT);
}

/** Move the pointer to a viewport coordinate and wait for the CSS glide to settle. */
export async function glideTo(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(({ x, y }) => (window as unknown as { __ss?: { moveTo(x: number, y: number): void } }).__ss?.moveTo(x, y), { x, y });
  await page.waitForTimeout(GLIDE_MS + 40);
}

/** Glide the pointer to a selector's centre, ripple, then click it. */
export async function glideAndClick(page: Page, selector: string): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(() => {});
  const box = await loc.boundingBox();
  if (box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await glideTo(page, x, y);
    await page.evaluate(({ x, y }) => (window as unknown as { __ss?: { ripple(x: number, y: number): void } }).__ss?.ripple(x, y), { x, y });
    await page.waitForTimeout(120);
  }
  await loc.click({ timeout: ACTION_TIMEOUT });
}

/** Glide to a field, focus it, clear it, and type character by character at a human pace. */
export async function glideAndType(page: Page, selector: string, text: string): Promise<void> {
  const loc = page.locator(selector).first();
  await loc.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(() => {});
  const box = await loc.boundingBox();
  if (box) await glideTo(page, box.x + box.width / 2, box.y + box.height / 2);
  await loc.click({ timeout: ACTION_TIMEOUT });
  await loc.fill('').catch(() => {});
  await loc.pressSequentially(text, { delay: TYPE_DELAY_MS });
}

/**
 * Execute one parsed action. `humanize` routes clicks and typing through the pointer
 * glide; without it the page is driven directly. An action timeout is logged, not thrown
 * — the step's `_Prove:_` is the real gate, so a genuinely stuck step still shows a frame
 * and fails its proof rather than aborting the run.
 */
export async function runAction(page: Page, base: string, act: DemoAction, humanize: boolean, log: (m: string) => void): Promise<void> {
  try {
    switch (act.verb) {
      case 'goto':
        await page.goto(joinUrl(base, act.target), { waitUntil: 'load', timeout: ACTION_TIMEOUT });
        return;
      case 'wait':
        await page.waitForTimeout(act.ms ?? 0);
        return;
      case 'waitFor':
        await page.waitForSelector(act.target, { state: 'visible', timeout: ACTION_TIMEOUT });
        return;
      case 'waitForText':
        await page.waitForFunction(
          ({ sel, sub }) => (document.querySelector(sel)?.textContent ?? '').includes(sub),
          { sel: act.target, sub: act.text ?? '' },
          { timeout: ACTION_TIMEOUT },
        );
        return;
      case 'click':
        if (humanize) await glideAndClick(page, act.target);
        else await page.click(act.target, { timeout: ACTION_TIMEOUT });
        return;
      case 'type':
        if (humanize) await glideAndType(page, act.target, act.text ?? '');
        else await page.locator(act.target).first().fill(act.text ?? '', { timeout: ACTION_TIMEOUT });
        return;
      case 'scroll':
        // Centre the element so the frame actually SHOWS it (a panel below the fold
        // passes its DOM assertion but is off-screen).
        await page.locator(act.target).first().evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
        await page.waitForTimeout(150);
        return;
    }
  } catch (e) {
    log(`  · action \`${act.verb} ${act.target}\` did not settle: ${(e as Error).message.split('\n')[0]}`);
  }
}

function compare(actual: number, op: string, n: number): boolean {
  switch (op) {
    case '>=': return actual >= n;
    case '>': return actual > n;
    case '==': return actual === n;
    case '<=': return actual <= n;
    case '<': return actual < n;
    default: return false;
  }
}

/** Evaluate one assertion against the live page (single check, no polling). */
export async function checkAssertion(page: Page, a: Assertion): Promise<boolean> {
  try {
    switch (a.kind) {
      case 'visible':
        return await page.locator(a.selector as string).first().isVisible();
      case 'hidden': {
        // Hidden means NO match is visible — it must not pass just because the first
        // match is hidden while a later one is showing.
        const loc = page.locator(a.selector as string);
        const c = await loc.count();
        for (let i = 0; i < c; i++) {
          if (await loc.nth(i).isVisible()) return false;
        }
        return true;
      }
      case 'count': {
        const c = await page.locator(a.selector as string).count();
        return compare(c, a.op as string, a.n as number);
      }
      case 'text': {
        const t = (await page.locator(a.selector as string).first().textContent()) ?? '';
        return a.matcher?.type === 'regex' ? new RegExp(a.matcher.value).test(t) : t.includes(a.matcher?.value ?? '');
      }
      case 'eval':
        return Boolean(await page.evaluate(a.expr as string));
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** Poll an assertion until it holds or the timeout elapses. */
export async function awaitAssertion(page: Page, a: Assertion, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await checkAssertion(page, a)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}
