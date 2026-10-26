---
name: Passing Vercel's sign-in — what ss-azul found
description: How Vercel's Deployment Protection answered the previews SprintShow had to capture, with and without the bypass key and its cookie; the Playwright behaviours that decided how the engine sends the key; and the design it takes from them.
---

# Passing Vercel's sign-in

A growth-factor pull request's preview answers a browser with Vercel's sign-in, so a
capture with `--base-url <preview>` would film Vercel's sign-in page. The city holds a
Protection Bypass for Automation key as `VERCEL_AUTOMATION_BYPASS_SECRET`, valid on
growth-factor's and Signal Loom's Vercel projects. Before the engine was taught to use
it, Vercel's answers and Playwright's handling of headers, redirects and cookies were
measured, and the design follows from what they showed.

## How Vercel answers

Measured on 2026-10-26 from the agent host, against the previews of growth-factor's PRs
#28 and #30, at `/` and at a deep path with a query, with Node's `fetch` following no
redirect and asking for a page:

| The request carries | Vercel answers |
|---|---|
| nothing | 302 to `https://vercel.com/sso-api?url=…&nonce=…`, setting `_vercel_sso_nonce` |
| the key | the app: 200, or the app's own 404 at a path it lacks |
| the key and `x-vercel-set-bypass-cookie: true` | 307 to the same URL, path and query kept, setting a host-only `_vercel_jwt` (`Max-Age=604800; Path=/; Secure; HttpOnly; SameSite=Lax`) |
| the `_vercel_jwt` cookie | the app, at any path on the host |
| the cookie, the key and `x-vercel-set-bypass-cookie: true` | the app, with no second 307 |
| a wrong key and `x-vercel-set-bypass-cookie: true` | the same 302 as a request that carries nothing |

The cookie alone passes the sign-in for every path on the host. A wrong key reads exactly
like no key. The sign-in is told apart by its redirect target alone.

## How Playwright carries a header

Measured with Playwright 1.63 and its Chromium headless shell, against two local stub
servers on different origins:

- A route handler is called for a request the page makes, and never for a redirect that
  request follows. A route on the redirect's origin is not called for it either.
- A header override given to `route.continue` rides every redirect the request follows,
  a redirect to another origin included. Routing the app's origin to add the key would
  hand the key to any origin the app redirects to.
- A cookie set on an answer to `page.request`, the browser context's own request client,
  lands in the cookie jar the page uses, and the page's next navigation carries it.
- A `page.request` call that fails throws an error whose call log lists the request's
  headers, the key among them. The error's first line lists none.

## What the engine does

`openSurface` calls `passVercelSignIn` (`src/vercel.ts`) before the page opens a page
script's start path, so the walkthrough, the proof cut, the screenshot and a library
driver all pass the sign-in the same way.

- **It asks first, without the key.** The engine requests the start path with
  `page.request`, following no redirect. An answer that is not a redirect to
  `vercel.com/sso-api` ends the check, and the key stays unsent. A target the engine
  cannot ask at all is left to the browser, whose navigation says why. A page a library
  caller serves from a route, on an origin no server answers, still opens.
- **The key travels in one request, which follows no redirect.** A second request for the
  start path carries `x-vercel-protection-bypass` and `x-vercel-set-bypass-cookie: true`.
  Vercel's 307 is not followed, so the key reaches the app's origin and no other. The
  cookie that answer sets lands in the jar the page shares, and the page's own requests
  carry the cookie, never the key. A route that added the header to the page's requests
  would leak it through a redirect, and the context-wide `extraHTTPHeaders` that Vercel's
  documentation shows sends it to every origin the page loads.
- **It checks that the cookie passes before the page opens.** A third request, carrying
  only what the context now holds, must not answer with the sign-in. A key the deployment
  refuses is caught here, before the browser could film the sign-in.
- **It stops instead of filming the sign-in.** With no key, or a refused one, or a request
  that fails once the target is known to be protected, the capture fails with a message
  that says it reached Vercel's sign-in, and saves nothing.
- **It writes the key nowhere.** The key comes from the environment and from no flag. No
  log line, caption, narration line, URL or working file holds it. An error from these
  requests keeps only its first line, so Playwright's call log never carries the key into
  a message.

## How it was checked

Against the PR #28 preview, with the key from `~/.gc/secrets.env`: the first request got
the 302, the request carrying the key got the 307 and the cookie, the check got a 200,
and the page opened on Growth Factor's daily brief. None of the 14 requests the browser
then made, 13 to the preview and 1 to `vercel.live`, carried a Vercel header.

`test/vercel.test.ts` runs the same exchange against a stub that answers as the table
above does. The capture sends the key once, to the app's origin, and the page's script and
image from another origin arrive without it. The key is in no output and in no file of
the kept working directory. Without the key, or with a refused one, the capture stops
before the page asks for the app. A request carrying the key that fails stops it with an
error that lists no header.
