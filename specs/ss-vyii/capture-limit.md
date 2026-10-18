---
name: The full-page capture limit — what ss-vyii found
description: How a --full-page capture was found to stop at Chromium's tile budget, not at 16384 pixels, in tiles of 256 or of 512 pixels; the measurements that show it; and the bound and the capture time the screenshot driver takes from them.
---

# The full-page capture limit

The review of the terminal surface asked whether a `--full-page` still of a long terminal
session passes Chromium's capture limit, put at about 16384 pixels, and asked for the limit
to be reproduced before any cap was set. It was reproduced on the engine's own browser, the
Chromium headless shell that Playwright 1.63 installs, on macOS. The limit is not a height.
Chromium rasterizes a capture in tiles, holds at most 512 MiB of them, and leaves the part
of a capture past them unpainted. That is 2048 tiles of 256 device pixels, or 512 tiles of
512 pixels in a browser started on a screen at scale 2 or more on macOS. A page script's
`--full-page` capture meets the same limit.

## How it was reproduced

A terminal script ran a loop that prints numbered lines, each a bar the width of the
terminal whose background colour encodes its number. The script was captured with
`--full-page` at several scales and terminal widths, and the PNG's pixel in every row was
checked against its bar's colour. A page of bands 100 pixels tall, each coloured by its
index, was captured the same way. The reproduction's scripts are not kept. The cases that
decided the cap run again in `test/terminal.test.ts` and `test/screenshot.test.ts`.

The review of the first bound, which assumed 256-pixel tiles, ran the page capture in a
browser started with `--force-device-scale-factor=2`. On macOS such a browser draws in
512-pixel tiles, and the capture came out with its last bands white. The same captures
were then taken in a browser started that way. Each PNG was scanned in every row, at
columns 127 device pixels apart, for the first row left unpainted.

## What was found

Each capture below was asked for whole. The device row ranges are the last row seen drawn
and the first seen unpainted. The bound is where the budget's tiles run out at the
capture's width, laid from the page's top-left corner: 2048 tiles laid every 254 device
pixels, or 512 laid every 510.

| Capture | Scale | Tile | PNG, device pixels | Tiles across | Drawn, then unpainted | Bound |
|---|---|---|---|---|---|---|
| 80x24 terminal, 1002 lines | 1 | 256 | 1184 x 28112 | 5 | whole | 103886 |
| 80x24 terminal, 1002 lines | 2 | 256 | 2368 x 56224 | 10 | 51804, 51860 | 51816 |
| 80x24 terminal, 1002 lines | 3 | 256 | 3552 x 84336 | 14 | 37050, 37134 | 37084 |
| 80x24 terminal, 1002 lines | 4 | 256 | 4736 x 112448 | 19 | 27112, 27224 | 27178 |
| 40x24 terminal, 1002 lines | 2 | 256 | 1212 x 56224 | 5 | whole | 103886 |
| 160x48 terminal, 1002 lines | 2 | 256 | 2368 x 28168 | 10 | whole | 51816 |
| 1280 x 30000 page | 2 | 256 | 2560 x 60000 | 11 | 47100, 47300 | 47244 |
| 80x24 terminal, 1002 lines | 1 | 512 | 1184 x 28112 | 3 | whole | 86700 |
| 80x24 terminal, 1002 lines | 2 | 512 | 2368 x 56224 | 5 | 52020, 52021 | 52020 |
| 80x24 terminal, 1002 lines | 3 | 512 | 3552 x 84336 | 7 | 37230, 37231 | 37230 |
| 80x24 terminal, 1002 lines | 4 | 512 | 4736 x 112448 | 10 | 26010, 26011 | 26010 |
| 40x24 terminal, 1002 lines | 2 | 512 | 1212 x 56224 | 3 | whole | 86700 |
| 1280 x 30000 page | 2 | 512 | 2560 x 60000 | 6 | 43350, 43351 | 43350 |

- **It is an area, not a height.** The 40-column window was as tall as the 80-column window
  that was cut, and half as wide, and it was drawn whole.
- **It is Chromium's tile memory.** A crop of the scale-2 terminal still shows the unpainted
  part as a staircase of tiles. Every row of tiles is whole down to device row 51816, which
  is 204 rows of 254, then 8 of the next row's 10 tiles are drawn: 2048 tiles in all, at
  256 KiB each. Launched with `--force-gpu-mem-available-mb=256`, the same capture was cut
  after 1024 tiles, at the bound for that budget. Chromium's
  `third_party/blink/renderer/platform/widget/compositing/layer_tree_settings.cc` sets the
  budget in `GetGpuMemoryPolicy`. On a desktop platform it is 512 MiB for a small screen,
  raised in proportion for a larger one.
- **The tile size is set when the browser starts.** In Chromium 153.0.8010.12,
  `GenerateLayerTreeSettings` in the same file makes the tile 256 pixels. On macOS and
  ChromeOS it makes it 512 when the screen the browser starts on has a scale of 2 or more.
  The engine's browser starts on a headless screen at scale 1, and the scale Playwright
  gives a page (`deviceScaleFactor`) leaves the tile size as it is. So the first captures,
  at scales 2 to 4 on macOS, all used 256-pixel tiles. The browser started at scale 2 drew
  in 512-pixel tiles, laid every 510 device pixels. Each capture it cut was whole down to
  the bound, and then one or two tiles of the next row were drawn: 512 tiles in all, at
  1 MiB each, the same 512 MiB. These are the tiles of Chromium's software rasterizer,
  which the headless shell uses. Its GPU feature status reports rasterization as
  `disabled_software`.
- **Nothing reports it.** The part past the budget is transparent in a terminal still,
  which leaves out the page's background, and white in a page capture. The capture
  succeeds and the PNG has the size it was asked for.
- **A clipped capture can fall short of the budget.** A page capture clipped above the end
  of the page was drawn 24 tiles short of 2048 in 3 of 13 runs, and to the full budget in
  the others. Measured again beside the 512-pixel captures, asking for more than the
  budget, it was 24 tiles short in 1 of 6 runs. In 512-pixel tiles it fell short by the
  same 24 tiles, not the same memory: 488 of 512 were drawn in 1 of 6 runs at scale 2 and
  2 of 6 at scale 3. Asked for the bound, 480 tiles, the 512-pixel capture was drawn whole
  in 15 of 15 runs at scale 2 and 6 of 6 at scale 3. A capture that reaches the end of its
  page was never short, and a terminal session's full-page still always does, since its
  window is the page.
- **A tile of one solid colour takes no tile memory.** Chromium checks each tile for a
  single colour before it charges the tile's memory (`cc/tiles/tile_manager.cc`), and
  draws such a tile without rasterizing it. A page of 100-pixel bands at scale 3, where a
  256-pixel tile can lie inside one band, drew past the 2048-tile budget in 6 of 6 runs.
  With a 1-pixel rule at the top of each band, the same capture was cut at 2048 tiles.
  The bound counts every tile, so a page with such tiles holds less than Chromium could
  draw, never more. The tests' bands and terminal lines are shorter than a tile at the
  scales they are captured at, so every tile they span costs memory.
- **Capture time grows with the tiles.** On an 18-core host with a load average of 50 to
  90, a capture of 555 tiles took 14 s, one of 900 tiles 27 s, and one of 2048 tiles 40 to
  60 s. The engine gave every capture 15 s, so on that host a `--full-page` still of a
  400-line session at `--scale 2` failed with a timeout and saved nothing, long before it
  reached the tile budget.

## What the screenshot driver does with it

- A full-page capture spans at most 15/16 of the budget in tiles of either size: 1920
  tiles of 256 pixels, or 480 of 512. The sixteenth left unspent is 32 tiles at the
  least, room for the 24-tile shortfall seen in either size. A page cannot tell which
  size its browser draws in, so `captureHeightLimit` in `src/screenshot.ts` gives the
  lower of the two tallest captures at the capture's width and scale.
- A terminal still grows its window to as many of the session's last lines as fit, so the
  screen, which the default still shows, is always in it. A page capture keeps the page's
  top. Either way the log says what the capture holds of the whole.
- A capture is given 15 s and 100 ms more for each tile it spans, about three times the
  slowest rate measured. The tiles are counted at 256 pixels whatever size the browser
  draws in, so a capture of the same area gets the same time in either browser.

At `--scale 2` this keeps the last 868 lines of an 80-column session drawn at 24 px, and
the top 20,400 CSS pixels of a page 1280 pixels wide. At `--scale 1` every session the
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
- **Reading the tile size the browser draws in.** A page cannot see it. Its
  `devicePixelRatio` is the scale Playwright gives the page, not the scale of the screen
  the browser started on. A new context with no viewport does report that screen's scale,
  so the engine could work the tile size out from it. That would copy Chromium's rule for
  the size, which a flag such as `--default-tile-width` or another Chromium release
  changes, and a page from a persistent context has no browser to open the context in. A
  bound that holds for both sizes costs little instead. At `--scale 2` it leaves out
  1,698 CSS pixels of a 1280-pixel-wide page that a browser drawing in 256-pixel tiles
  would draw, and nothing of an 80-column session.

## What is left

An element capture (`--selector`) of an element taller than the bound still asks Chromium
for more than it draws, and so does any capture at a scale where even the viewport spans
more than the budget, from about `--scale 11`. Both come out partly blank. ss-emhj tracks
them.

The bound is measured for Chromium's software rasterizer, which the headless shell uses. A
caller's browser that rasterizes on the GPU, such as a headed Chrome, lays its tiles out
another way, and a capture of its page was not measured. ss-z9ak tracks it.
