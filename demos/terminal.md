# Demo: Sprint board in a terminal — a command and a full-screen board

**Terminal:** 100x30

The sample's sprint board, driven from a shell: the backlog is a plain file, a command
counts it in colour, and a full-screen board edits it from the keyboard. Every step is
checked against the terminal's screen, a row, the cursor or the last exit status.

## Steps

1. **The backlog is a plain markdown file**
   `run cat tasks.md`
   _Prove:_ the first task is listed — `screen ~ "- [ ] Ship the demo engine"`
   _Fail if:_ the file could not be read — `exit > 0`

2. **A command counts the board, in colour**
   `run node board.mjs --summary`
   _Prove:_ three tasks, one of them done — `screen ~ /^3 tasks · 1 done$/`

3. **The board opens full screen**
   `run node board.mjs`
   _Prove:_ its frame is drawn along the top row — `row 1 ~ /^┌─ Sprint board ─+┐$/`

4. **The cursor moves down to the second task**
   `press ArrowDown`
   _Prove:_ the cursor sits in the second task's checkbox — `cursor 4 6`

5. **Space marks it done**
   `press Space`
   _Prove:_ the status bar counts two done — `row -1 ~ /2 of 3 done$/`

6. **Quitting restores the shell**
   `press q`
   _Prove:_ the board exited cleanly — `exit == 0`
   _Fail if:_ the full-screen frame is still showing — `screen ~ "┌─ Sprint board"`

## Scrutiny

- The board is a real full-screen program: it switches screens, addresses the cursor and
  paints in colour, and the terminal draws what it sends.
- Quitting brings back the shell's screen as it stood before the board opened.
- Nothing is saved: tasks.md reads the same after the demo.
