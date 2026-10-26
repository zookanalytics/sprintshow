// Vercel's Deployment Protection. A deployment behind it answers a request that carries
// neither its bypass key nor the cookie the key earns with Vercel's sign-in, a redirect
// to vercel.com/sso-api, so a browser sent to the app shows Vercel's sign-in page
// instead. Vercel's Protection Bypass for Automation key passes the sign-in. The engine
// reads the key from VERCEL_AUTOMATION_BYPASS_SECRET, the name Vercel gives it, and from
// no flag.
//
// The key goes out only when it is needed, and only to the app's origin. Before the
// browser opens a page script's start path, the engine requests that URL itself, with
// the page's browser context but outside the page, and without the key. Only an answer
// that is Vercel's sign-in brings the key out. One request for the same URL, which
// follows no redirect, carries it and asks Vercel to set its bypass cookie. The cookie
// lands in the cookie jar the context shares with the page, so the page's requests to
// the app's host carry the cookie and none carries the key. A header the browser sent
// would not stay on the app's origin: Playwright adds a route's header overrides to
// every redirect the request follows, including one to another origin.
//
// The key is written nowhere: not to the log, a caption, the narration, a URL or a file,
// and not into an error. Playwright lists a failed request's headers in its error's call
// log, so an error from a request made here keeps only its first line, which lists none.

import type { Page } from 'playwright';

/** The environment variable that holds the Protection Bypass for Automation key. */
export const VERCEL_BYPASS_VAR = 'VERCEL_AUTOMATION_BYPASS_SECRET';

/** An Accept header that asks for a page, as a navigation does, so the start path is requested as the browser will request it. */
const PAGE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

/** True when an answer with `status` and `location`, to a request for `url`, is Vercel's sign-in: a redirect to vercel.com/sso-api. */
export function isVercelSignIn(status: number, location: string | undefined, url: string): boolean {
  if (status < 300 || status >= 400 || !location) return false;
  try {
    const to = new URL(location, url);
    return to.hostname === 'vercel.com' && /^\/sso-api(\/|$)/.test(to.pathname);
  } catch {
    return false;
  }
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
 * Let `page`'s browser context open `url` when it is behind Vercel's sign-in, before the
 * page asks for it. When `url` does not answer with the sign-in, this sends nothing more.
 * When it does, the key in `env` is sent once, in a request for `url` that asks Vercel to
 * set its bypass cookie, and `url` is asked again to check that the cookie passes the
 * sign-in. Throws when `url` answers with the sign-in and there is no key, when it still
 * answers with the sign-in once the key is sent, or when either request fails, so a
 * capture never films the sign-in page. A target the engine cannot ask at all is left to
 * the browser, whose navigation says why it cannot open it.
 */
export async function passVercelSignIn(page: Page, url: string, log: (m: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const signIn = async (): Promise<boolean> => {
    const { status, location } = await answer(page, url);
    return isVercelSignIn(status, location, url);
  };
  try {
    if (!(await signIn())) return;
  } catch {
    return;
  }

  const at = `Vercel's sign-in at ${new URL(url).origin}`;
  const key = env[VERCEL_BYPASS_VAR]?.trim();
  if (!key) {
    throw new Error(`vercel: the capture reached ${at}, a redirect to vercel.com/sso-api, so it stops rather than film the sign-in page. Set ${VERCEL_BYPASS_VAR} to the project's Protection Bypass for Automation key to pass it.`);
  }
  try {
    await answer(page, url, { 'x-vercel-protection-bypass': key, 'x-vercel-set-bypass-cookie': 'true' });
  } catch (e) {
    throw new Error(`vercel: the capture reached ${at}, and the request carrying ${VERCEL_BYPASS_VAR} failed: ${(e as Error).message.split(key).join('[key]')}`);
  }
  let passed: boolean;
  try {
    passed = !(await signIn());
  } catch (e) {
    throw new Error(`vercel: the capture reached ${at}, and the request checking that ${VERCEL_BYPASS_VAR} passed it failed: ${(e as Error).message}`);
  }
  if (!passed) {
    throw new Error(`vercel: the capture reached ${at}, and it still answers with the sign-in once ${VERCEL_BYPASS_VAR} is sent, so the key does not pass this deployment's protection.`);
  }
  log(`vercel: ${VERCEL_BYPASS_VAR} passed ${at}`);
}
