// Vercel's Deployment Protection. A deployment behind it answers a request that carries
// neither its bypass key nor the cookie the key earns with Vercel's sign-in, a redirect
// to vercel.com/sso-api, so a browser sent to the app shows Vercel's sign-in page
// instead. Vercel's Protection Bypass for Automation key passes the sign-in. The engine
// reads the key from VERCEL_AUTOMATION_BYPASS_SECRET, the name Vercel gives it, and from
// no flag.
//
// The key goes out only when it is needed, and only to the app. Before the browser opens
// a page script's start path, the engine requests that URL itself, with the page's
// browser context but outside the page, and without the key. It follows the redirects
// the answers name one request at a time, as the browser's navigation follows them, so
// it meets the sign-in wherever the browser would. Given a deployment's http:// URL,
// which Vercel redirects to its https:// URL, it meets the sign-in one request later.
// Only an answer that is Vercel's sign-in brings the key out, and only when the URL that
// answered is on the start URL's origin or on its host over https. One request for that
// URL, which follows no redirect, carries the key and asks Vercel to set its bypass
// cookie. The cookie lands in the cookie jar the context shares with the page, so the
// page's requests to the app's host carry the cookie and none carries the key. A header
// the browser sent would not stay on the app's origin: Playwright adds a route's header
// overrides to every redirect the request follows, including one to another origin.
//
// The key is written nowhere: not to the log, a caption, the narration, a URL or a file,
// and not into an error. Playwright lists a failed request's headers in its error's call
// log, so an error from a request made here keeps only its first line, which lists none.

import type { Page } from 'playwright';

/** The environment variable that holds the Protection Bypass for Automation key. */
export const VERCEL_BYPASS_VAR = 'VERCEL_AUTOMATION_BYPASS_SECRET';

/** An Accept header that asks for a page, as a navigation does, so the start path is requested as the browser will request it. */
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** The statuses whose Location a navigation follows. Chromium follows no other, a 300 among them. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The most requests a navigation makes for one page: Chromium follows 19 redirects, and the 20th fails the navigation. */
const MAX_REQUESTS = 20;

/** True when an answer with `status` and `location`, to a request for `url`, is Vercel's sign-in: a redirect to vercel.com/sso-api. */
export function isVercelSignIn(status: number, location: string | undefined, url: string): boolean {
  if (!REDIRECTS.has(status) || !location) return false;
  try {
    const to = new URL(location, url);
    return to.hostname === 'vercel.com' && /^\/sso-api(\/|$)/.test(to.pathname);
  } catch {
    return false;
  }
}

/**
 * True when the key may be sent to `url`, a URL on the way from the start URL `start`: one
 * on the start URL's origin, or one on its host over https, where Vercel redirects an
 * http:// URL. No other origin on the way receives it.
 */
export function mayReceiveKey(start: string, url: string): boolean {
  const from = new URL(start);
  const to = new URL(url);
  return to.origin === from.origin || (to.protocol === 'https:' && to.hostname === from.hostname);
}

/**
 * The status and Location of the answer to a GET of `url` with `headers`, made with
 * `page`'s browser context outside the page and following no redirect. A request that
 * fails throws an error holding only the first line of Playwright's.
 */
async function answer(page: Page, url: string, headers: Record<string, string> = {}): Promise<{ status: number; location: string | undefined }> {
  try {
    const res = await page.request.get(url, { headers: { accept: PAGE_ACCEPT, ...headers }, maxRedirects: 0 });
    const got = { status: res.status(), location: res.headers().location };
    await res.dispose().catch(() => {});
    return got;
  } catch (e) {
    throw new Error((e as Error).message.split('\n')[0]);
  }
}

/**
 * The URL that answers with Vercel's sign-in on the browser's way from `url` to a page, or
 * null when the way ends without it. Each request is made by `answer`, without the key.
 * The way follows each redirect a navigation follows, and ends where a navigation ends:
 * at an answer that is no such redirect, at a Location that is not http or https, or at a
 * redirect that MAX_REQUESTS leaves no request for. A request that fails throws.
 */
async function signInOnTheWay(page: Page, url: string): Promise<string | null> {
  let at = url;
  for (let made = 1; ; made++) {
    const { status, location } = await answer(page, at);
    if (isVercelSignIn(status, location, at)) return at;
    if (!REDIRECTS.has(status) || !location || made === MAX_REQUESTS) return null;
    let next: URL;
    try {
      next = new URL(location, at);
    } catch {
      return null;
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
    at = next.href;
  }
}

/**
 * Let `page`'s browser context open `url` when the way to its page meets Vercel's sign-in,
 * before the page asks for it. When no answer on the way is the sign-in, this sends
 * nothing more. When one is, the key in `env` is sent once, in a request for the URL that
 * answered with it, which asks Vercel to set its bypass cookie, and the way is walked
 * again to check that the cookie passes the sign-in. Throws when the URL that answered
 * with the sign-in may not receive the key, when there is no key, when the way still
 * meets a sign-in once the key is sent, or when a request fails once the sign-in is met,
 * so a capture never films the sign-in page. A start URL the engine cannot ask at all is
 * left to the browser, whose navigation says why it cannot open it, and so is one whose
 * way the engine cannot follow to its end.
 */
export async function passVercelSignIn(page: Page, url: string, log: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let at: string | null;
  try {
    at = await signInOnTheWay(page, url);
  } catch {
    return;
  }
  if (!at) return;

  const origin = new URL(at).origin;
  const signIn = `Vercel's sign-in at ${origin}`;
  if (!mayReceiveKey(url, at)) {
    throw new Error(`vercel: the capture's start path redirects to ${signIn}, and ${VERCEL_BYPASS_VAR} goes only to the base URL's origin or to its host over https, so the capture stops rather than film the sign-in page. Give ${origin} as the base URL to pass it.`);
  }
  const key = env[VERCEL_BYPASS_VAR]?.trim();
  if (!key) {
    throw new Error(`vercel: the capture reached ${signIn}, a redirect to vercel.com/sso-api, so it stops rather than film the sign-in page. Set ${VERCEL_BYPASS_VAR} to the project's Protection Bypass for Automation key to pass it.`);
  }
  try {
    await answer(page, at, { 'x-vercel-protection-bypass': key, 'x-vercel-set-bypass-cookie': 'true' });
  } catch (e) {
    throw new Error(`vercel: the capture reached ${signIn}, and the request carrying ${VERCEL_BYPASS_VAR} failed: ${(e as Error).message.split(key).join('[key]')}`);
  }
  let still: string | null;
  try {
    still = await signInOnTheWay(page, url);
  } catch (e) {
    throw new Error(`vercel: the capture reached ${signIn}, and the request checking that ${VERCEL_BYPASS_VAR} passed it failed: ${(e as Error).message}`);
  }
  if (still !== null && new URL(still).origin === origin) {
    throw new Error(`vercel: the capture reached ${signIn}, and it still answers with the sign-in once ${VERCEL_BYPASS_VAR} is sent, so the key does not pass this deployment's protection.`);
  }
  if (still !== null) {
    throw new Error(`vercel: ${VERCEL_BYPASS_VAR} passed ${signIn}, and past it the start path redirects to Vercel's sign-in at ${new URL(still).origin}, so the capture stops rather than film the sign-in page.`);
  }
  log(`vercel: ${VERCEL_BYPASS_VAR} passed ${signIn}`);
}
