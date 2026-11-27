---
name: Which tiles a capture spends — what ss-emhj found
description: How a capture of part of a page, such as an element or a clip below the page's top, was found to spend Chromium's tile budget on its own area alone, on tiles laid from the page's top-left corner; the measurements that show it; and the bound, the refusals and the one capture helper the screenshot driver takes from them.
---

# Which tiles a capture spends

The full-page capture limit (specs/ss-vyii/capture-limit.md) holds a capture that starts at
the page's top-left corner to the tiles Chromium draws. An element capture (`--selector`)
and a capture of the viewport were left without a limit, and both came out partly blank
past it: a tall element at any scale, and the viewport from about `--scale 11`. Holding
them to the limit needed two things the full-page captures, all taken from the page's
corner, could not show. One is whether a capture of part of a page spends tiles on the
rest of the page or of the viewport. The other is where the tiles of a capture that starts
lower down are laid.

## How it was measured

A probe drove the engine's own browser, the headless shell Playwright 1.63 installs, on
macOS. It drew in tiles of 256 pixels, and, started with the flags in `HIGH_DPI_ARGS`
(test/browser-fixture.ts), in tiles of 512. Every page was striped in columns 4 CSS pixels
apart, so no tile was one solid colour, which costs no tile memory. Each PNG was scanned in
every row, at columns 127 device pixels apart, for the first row left unpainted. The probe
is not kept. The cases that decided the limit run again in `test/screenshot.test.ts`.

## What was found

The rows are device pixels of the PNG. The bound is what the screenshot driver now holds
the capture to, in device pixels.

| Capture | Scale | Tile | PNG | Last row drawn | Bound |
|---|---|---|---|---|---|
| The 1280x900 viewport | 11 | 256 | 14080 x 9900 | 9144 | refused |
| A 300x200 element at the viewport's bottom right | 11 | 256 | 3300 x 2200 | whole | whole |
| A clip of the viewport at that element's box | 11 | 256 | 3300 x 2200 | whole | whole |
| A full-page clip 785 px tall at the page's top | 11 | 256 | 14080 x 8635 | whole | 8635 |
| A full-page clip 900 px tall at the page's top | 11 | 256 | 14080 x 9900 | 9144 | 8635 |
| A full-page clip 785 px tall, 2000 px down the page | 11 | 256 | 14080 x 8635 | whole | 8470 |
| A full-page clip 20000 px tall, 20000 px down the page | 2 | 256 | 2560 x 40000 | whole | 40580 |
| The same | 2 | 512 | 2560 x 40000 | whole | 40580 |
| A 1280x30000 element 5000 px down the page, as Playwright captures it | 2 | 256 | 2560 x 60000 | 47150 | 40490 |
| The same element, as a full-page clip of its box | 2 | 256 | 2560 x 60000 | 47150 | 40490 |
| The element, as Playwright captures it | 2 | 512 | 2560 x 60000 | 43040 | 40490 |
| The element, as a full-page clip of its box | 2 | 512 | 2560 x 60000 | 43040 | 40490 |

- **A capture spends tiles on its own area alone.** The viewport at scale 11 spans 56 by 39
  tiles of 256 pixels, 2184 of them, more than the 2048 Chromium holds. It was cut where
  the 2048th tile ends: 36 whole rows of 56, then 32 tiles of the next row. An element in
  the part of the viewport that was cut came out whole, and so did a clip of its box. So
  did clips lower down a page, though the rows of tiles above them would have spent the
  budget several times over.
- **Its tiles are laid from the page's top-left corner.** The element 5000 px down the page
  starts 10000 device pixels down, partway through the 40th row of tiles laid every 254
  pixels from the page's top. Counted from that row, 186 whole rows of 11 tiles end at
  device row 57150 of the page, which is row 47150 of the element. It was drawn down to
  that row exactly. Tiles laid from the element's own top would have ended at its row
  47244. In 512-pixel tiles, 85 rows of 6 counted from the page's grid end at the
  element's row 43040, where it was cut.
- **Playwright's element capture is a clip of the page at the element's box.** Playwright
  scrolls the element into view, measures its box from the page's top-left corner, and
  captures that box, beyond the viewport when it does not fit the viewport (`screenshotElement`
  in the installed `playwright-core`). Its capture of the tall element and a full-page clip
  of the element's box were cut at the same rows.
- **So the viewport is what passes the budget at a large scale, not every capture.** An
  element or a clip is held to its own area, at any scale.

### A page a phone draws smaller to fit its screen

A phone lays out a page with no viewport tag 980 CSS pixels wide, and draws it at the
scale that fits its screen, which the page's visual viewport reports. Playwright captures
the viewport at that scale (`takeScreenshot` in the installed `playwright-core`), so the
PNG is the screen's size at the device's scale. A second probe drew such a page as an
iPhone 13, whose screen is 390x664, so at a scale of 390/980. The page was a vertical
gradient on a green background, which showed where tiles were left unpainted. This probe
is not kept either. `test/device.test.ts` captures such a page at a scale at which its
980 CSS pixels would not fit, and refuses it at one at which its screen does not.

| Capture | Scale | Tile | PNG | Last row drawn | Bound |
|---|---|---|---|---|---|
| The 390x664 viewport at the page's top | 11 | 256 | 4290 x 7302 | whole | whole |
| The same | 11 | 512 | 4290 x 7302 | whole | whole |
| The same | 24 | 256 | 9360 x 15931 | 13970 | refused |
| The same | 24 | 512 | 9360 x 15931 | 13260 | refused |
| The viewport 1000 CSS px down the page | 24 | 256 | 9360 x 15931 | 13817 | refused |
| The same | 24 | 512 | 9360 x 15931 | 12889 | refused |

- **The page is drawn, and its tiles laid, at the visual viewport's scale.** Counted in
  the page's 980x1669 CSS pixels at scale 11, the viewport would span about 3,100 tiles of
  256, more than the budget, yet it came out whole. At scale 24 its 9360 device pixels
  span 37 tiles of 256 across. It was drawn for 55 whole rows of them, and the next row
  only at its left, which is where the 2048th tile ends. In tiles of 512 it was drawn for
  26 whole rows of 19, and the next row but at its right end.
- **The grid is laid from the page's corner on the page as drawn.** 1000 CSS px down the
  page, the viewport starts 1000 x 390/980 x 24 device pixels, or 9551, down the grid.
  Counted from the row of tiles that holds that row, 55 rows of 256 end at its row 13817,
  and 26 rows of 512 at its row 12889, where it was cut.

## What the screenshot driver does with it

- Every capture goes through `captureOf` in `src/screenshot.ts`: the screenshot command's
  viewport, full page, element, and terminal window or session, a run's screenshot of each
  step, and proof mode's frames. It measures the area where it lies on the page, and
  `captureHeightLimit` counts the tiles it spans from the area's top-left corner on the
  grid laid from the page's. It measures a viewport in its own pixels, the CSS pixels of
  the visual viewport times its scale, so a phone's is the size of its screen. Each
  capture is given `captureTimeout`'s time for those tiles.
- A full page and an element keep their top, and the log says what was left out. An
  element held whole is captured as Playwright captures it. The top of a taller one is a
  full-page clip of the part of its box one capture holds, the capture Playwright takes of
  the whole element.
- A viewport and a terminal window are captured whole or not at all, and a capture that
  cannot hold one whole fails, saying the scale is too large. A screenshot refuses its
  default capture before the steps run. `runScreenshot` refuses a page script's viewport
  at the size the last `resize` leaves it before a server starts, and `captureScreenshot`
  refuses it before it drives the page. It refuses a terminal's window once the terminal is
  laid out and before the first step. A full-screen program's window, which a full-page
  still captures as it is, is refused when it is captured.

At `--scale 2`, an element as wide as a 1280-pixel page keeps about its top 20,000 CSS
pixels, wherever it lies. One capture holds a 1280x900 viewport at the top of its page up to
`--scale 10`, and a phone's 393x659 viewport up to about `--scale 21`.

## Paths not taken

- **Refusing any capture at a scale where the 1280x900 viewport spans more than the
  budget**, as this bead first proposed. It would refuse a capture of a small element
  that Chromium draws whole, and it measures the wrong viewport: a script names a device
  or a size, and a `resize` changes it. A 3840x2160 viewport is past the budget from about
  `--scale 3.8`.
- **Keeping the top of a viewport or a terminal window.** A page and an element can be any
  height, so the top is all a capture can hold of one. A viewport is the area the script
  sets, and a window shows the screen, whose last lines are the newest. A copy cut short
  would show a state the script never left. The scale is the caller's to lower.
- **Taking every element through a clipped page capture**, measured once. An element held
  whole keeps Playwright's own capture, which scrolls it into view before it measures it,
  so only an element too tall for one capture is captured another way.
