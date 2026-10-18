---
name: The full-page capture limit — what ss-vyii found
description: How a --full-page capture was found to stop at Chromium's tile budget, not at 16384 pixels; the measurements that show it; and the bound and the capture time the screenshot driver takes from them.
---

# The full-page capture limit

The review of the terminal surface asked whether a `--full-page` still of a long terminal
session passes Chromium's capture limit, put at about 16384 pixels, and asked for the limit
to be reproduced before any cap was set. It was reproduced on the engine's own browser, the
Chromium headless shell that Playwright 1.63 installs, on macOS. The limit is not a height.
Chromium rasterizes a capture in tiles, holds at most 512 MiB of them, which is 2048 tiles
of 256 device pixels, and leaves the part of a capture past them unpainted. A page script's
`--full-page` capture meets the same limit.

## How it was reproduced

A terminal script ran a loop that prints numbered lines, each a bar the width of the
terminal whose background colour encodes its number. The script was captured with
`--full-page` at several scales and terminal widths, and the PNG's pixel in every row was
checked against its bar's colour. A page of bands 100 pixels tall, each coloured by its
index, was captured the same way. The reproduction's scripts are not kept. The cases that
decided the cap run again in `test/terminal.test.ts` and `test/screenshot.test.ts`.

## What was found

Each capture below was asked for whole. The device row ranges are the last row seen drawn
and the first seen unpainted. The bound is where 2048 tiles, laid every 254 device pixels
from the page's top-left corner, run out at the capture's width.

| Capture | Scale | PNG, device pixels | Tiles across | Drawn, then unpainted | Bound |
|---|---|---|---|---|---|
| 80x24 terminal, 1002 lines | 1 | 1184 x 28112 | 5 | whole | 103886 |
| 80x24 terminal, 1002 lines | 2 | 2368 x 56224 | 10 | 51804, 51860 | 51816 |
| 80x24 terminal, 1002 lines | 3 | 3552 x 84336 | 14 | 37050, 37134 | 37084 |
| 80x24 terminal, 1002 lines | 4 | 4736 x 112448 | 19 | 27112, 27224 | 27178 |
| 40x24 terminal, 1002 lines | 2 | 1212 x 56224 | 5 | whole | 103886 |
| 160x48 terminal, 1002 lines | 2 | 2368 x 28168 | 10 | whole | 51816 |
| 1280 x 30000 page | 2 | 2560 x 60000 | 11 | 47100, 47300 | 47244 |

- **It is an area, not a height.** The 40-column window was as tall as the 80-column window
  that was cut, and half as wide, and it was drawn whole.
- **It is Chromium's tile memory.** A crop of the scale-2 terminal still shows the unpainted
  part as a staircase of tiles. Every row of tiles is whole down to device row 51816, which
  is 204 rows of 254, then 8 of the next row's 10 tiles are drawn: 2048 tiles in all, at
  256 KiB each. Launched with `--force-gpu-mem-available-mb=256`, the same capture was cut
  after 1024 tiles, at the bound for that budget. Chromium's
  `third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc` sets the
  budget in `GetGpuMemoryPolicy`. On a desktop platform it is 512 MiB for a small screen,
  raised in proportion for a larger one. The tile is 256 pixels by default, and 512 on
  macOS and ChromeOS when the screen starts at a scale of 2 or more. The captures here, at
  scales 2 to 4 on macOS, all used 256-pixel tiles.
- **Nothing reports it.** The part past the budget is transparent in a terminal still,
  which leaves out the page's background, and white in a page capture. The capture
  succeeds and the PNG has the size it was asked for.
- **A clipped capture can fall short of the budget.** A page capture clipped above the end
  of the page was drawn 24 tiles short of 2048 in 3 of 13 runs, and to the full budget in
  the others. A capture that reaches the end of its page was never short, and a terminal
  session's full-page still always does, since its window is the page.
- **Capture time grows with the tiles.** On an 18-core host with a load average of 50 to
  90, a capture of 555 tiles took 14 s, one of 900 tiles 27 s, and one of 2048 tiles 40 to
  60 s. The engine gave every capture 15 s, so on that host a `--full-page` still of a
  400-line session at `--scale 2` failed with a timeout and saved nothing, long before it
  reached the tile budget.

## What the screenshot driver does with it

- A full-page capture spans at most 1920 tiles, 15/16 of the budget, which leaves room for
  the 24-tile shortfall seen. `captureHeightLimit` in `src/screenshot.ts` turns that into
  the tallest capture at the capture's width and scale.
- A terminal still grows its window to as many of the session's last lines as fit, so the
  screen, which the default still shows, is always in it. A page capture keeps the page's
  top. Either way the log says what the capture holds of the whole.
- A capture is given 15 s and 100 ms more for each tile it spans, about three times the
  slowest rate measured.

At `--scale 2` this keeps the last 868 lines of an 80-column session drawn at 24 px, and
the top 22,098 CSS pixels of a page 1280 pixels wide. At `--scale 1` every session the
terminal can hold is captured whole.

## Paths not taken

- **A cap at 16384 pixels.** Chromium draws far more than that. At `--scale 2` the cap
  would cut an 80-column session at about 290 lines, where a still captures it whole.
- **A larger budget, with `--force-gpu-mem-available-mb`.** It works, but a capture then
  holds that much more memory and takes that much longer, and it still needs a cap at the
  larger budget.
- **Capturing in bands and joining them into one PNG.** That removes the bound, but needs a
  PNG decoder and encoder in the engine, for stills already past a hundred million pixels.
- **Keeping the session's first lines.** The default still shows the screen, the end of the
  session. A full-page still that left the screen out would show less of what matters than
  the default does.

## What is left

An element capture (`--selector`) of an element taller than the bound still asks Chromium
for more than it draws, and so does any capture at a scale where even the viewport spans
more than the budget, from about `--scale 11`. Both come out partly blank. ss-emhj tracks
them.
