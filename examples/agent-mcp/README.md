# Agent / MCP path

The agent-driven path splits the work in two: an agent drives the browser through
[`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) and drops a screenshot per
step, then `sprintshow assemble` turns those frames into a narrated, captioned MP4. The
agent needs no browser or ffmpeg code of its own — only the MCP server and this package's
`assemble` entrypoint.

## Wiring

[`mcp.json`](mcp.json) registers the Playwright MCP server with an output directory. Point
your MCP client at it (Claude Code, Cursor, VS Code — each reads an `mcpServers` block in
this shape). `--output-dir` is where the agent's screenshots land; make it the captures
directory you will assemble.

## What the agent produces

In the captures directory, one PNG per step, zero-padded so they sort in order, plus a
`manifest.json` describing them:

```
.captures/agent-run/
  00-cover.png
  01-the-board-boots-empty.png
  02-add-the-first-task.png
  …
  manifest.json
```

`manifest.json` is the contract `assemble` reads:

```json
{
  "title": "Sprint board — add and complete tasks",
  "frames": [
    { "file": "00-cover.png",              "narration": "Sprint board",        "duration": 5,   "observation": null,               "proof": "passed", "severity": null },
    { "file": "01-the-board-boots-empty.png", "narration": "The board boots empty", "duration": 3.5, "observation": null,               "proof": "passed", "severity": null },
    { "file": "02-add-the-first-task.png",  "narration": "Add the first task",  "duration": 3.5, "observation": "manual proof",      "proof": "passed", "severity": null }
  ],
  "scrutiny": ["Counts come from the live DOM, not the captions"]
}
```

Field by field: `file` is the screenshot; `narration` is the caption and the spoken line;
`duration` is the base seconds the frame shows (stretched to fit narration when present);
`observation` is an optional note (a failed proof's reason, or a manual-proof marker) that
adds a second on screen; `proof` is `passed` | `adapted` | `failed`; `severity` is `error`
| `warning` | `null`.

## Assemble

```bash
sprintshow assemble .captures/agent-run -o demos/board.mp4
```

`assemble` encodes the frames into a silent MP4, then — with `OPENAI_API_KEY` set —
synthesizes and mixes in per-step narration. Add `--music <file.mp3>` for a background bed,
`--no-narrate` to force silence.

## Drafting a script

The frames and their captions can start from a demo script drafted in the generic
`demo:capture` dialect. Lint it (`sprintshow lint draft.md`), sharpen the captions, and use
its step order and narration as the agent's shot list.
