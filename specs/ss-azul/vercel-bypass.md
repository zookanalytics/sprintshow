---
name: Passing Vercel's sign-in — what ss-azul found
description: How Vercel's Deployment Protection answered the previews SprintShow had to capture, with and without the bypass key and its cookie; the Playwright and Chromium behaviours that decided how the engine finds the sign-in and sends the key; and the design it takes from them.
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

A request for the deployment's `http://` URL, carrying nothing, gets a 308 to the same URL
on `https://`, path and query kept, and only the `https://` URL answers with the sign-in.
Measured against PR #28's preview at `/capacity?week=1` on 2026-10-26 at 05:57Z, and with
curl at `/` and at `/capacity?week=1` at 07:45Z.

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
- A `page.request` call with `maxRedirects: 0` returns any 3xx answer as it came, its
  `Location` unfollowed.

## How a navigation follows redirects

Measured with the same Chromium, navigating a fresh page to a local stub:

- A navigation follows a 301, 302, 303, 307 or 308 to its `Location`, and no other status.
  A 300, 305 or 306 with a `Location` is shown as the page, and a 304 aborts the
  navigation.
- A navigation follows 19 redirects. At the 20th it fails with `ERR_TOO_MANY_REDIRECTS`,
  so it makes at most 20 requests for one page.

## What the engine does

`openSurface` calls `passVercelSignIn` (`src/vercel.ts`) before the page opens a page
script's start path, so the walkthrough, the proof cut, the screenshot and a library
driver all pass the sign-in the same way.

- **It walks the way first, without the key.** The engine requests the start path with
  `page.request`, following no redirect, and then requests each URL a redirect names, by
  the rules a navigation follows: only the five redirect statuses, only to an `http` or
  `https` URL, and for at most 20 requests. So it meets the sign-in wherever the browser
  would, behind a redirect such as Vercel's from `http://` to `https://` as well. A way
  that ends without the sign-in ends the check, and the key stays unsent. A target the
  engine cannot ask at all, or a way it cannot follow to its end, is left to the browser,
  whose navigation says why. A page a library caller serves from a route, on an origin no
  server answers, still opens.
- **The key travels in one request, which follows no redirect.** The request goes to the
  URL that answered with the sign-in, and carries `x-vercel-protection-bypass` and
  `x-vercel-set-bypass-cookie: true`. Vercel's 307 is not followed, so the key reaches that
  URL's origin and no other. That origin must be the start URL's, or the start URL's host
  over https, the one Vercel redirects `http://` to. A sign-in on any other origin the way
  leads to stops the capture with the key unsent. The cookie the 307 sets lands in the jar
  the page shares, and the page's own requests carry the cookie, never the key. A route
  that added the header to the page's requests would leak it through a redirect, and the
  context-wide `extraHTTPHeaders` that Vercel's documentation shows sends it to every
  origin the page loads.
- **It checks that the cookie passes before the page opens.** The engine walks the way
  again, carrying only what the context now holds, and the way must not meet the sign-in.
  A key the deployment refuses is caught here, before the browser could film the sign-in.
  So is a second sign-in on another origin past the one the key passed. The key is not
  sent a second time.
- **It stops instead of filming the sign-in.** With no key, or a refused one, or a sign-in
  on an origin the key does not go to, or a request that fails once the way is known to
  meet the sign-in, the capture fails with a message that says where it reached Vercel's
  sign-in, and saves nothing.
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
error that lists no header. A start path the stub redirects with a 308 before its
protection, as Vercel redirects `http://`, is passed with the key sent to the URL the
redirect leads to, and without the key the capture stops there. A sign-in on another host,
before the key is sent or after it passed the first, stops the capture with the key
unsent there. A redirect loop ends the walk after 20 requests, with the key unsent.
