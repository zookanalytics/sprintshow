# Demo: Sprint board on iOS — add and complete tasks

**Platform:** iOS

The board starts empty, takes tasks, and tracks how many are done, driven end to end in
the bundled sample iOS app on a simulator, with every step checked against the app's
screen through Appium.

## Steps

1. **The board boots empty**
   `waitFor new-task`
   The app opens straight onto the board, with its empty-state hint.
   _Prove:_ the empty-state hint is showing — `visible empty-hint`
   _Fail if:_ a task somehow already exists — `count task >= 1`

2. **Add the first task**
   `type new-task ~ Ship the demo engine`
   `click add`
   Typing a title and tapping Add appends a task and clears the field.
   _Prove:_ one task is on the board — `count task == 1`
   _Fail if:_ the empty hint is still showing — `visible empty-hint`

3. **Add a second task with the Return key**
   `type new-task ~ Write the README`
   `press Enter`
   _Prove:_ the board now holds two — `count task == 2`

4. **Add a third task**
   `type new-task ~ Cut the first release`
   `click add`
   _Prove:_ three tasks stand on the board — `text summary ~ /^3 tasks/`
   _Fail if:_ the add did not register and the count is stuck at two — `text summary ~ "2 tasks"`

5. **Mark the first task done**
   `click task`
   Completing a task strikes it through and updates the done count.
   _Prove:_ the first task reads as done — `text task ~ "done"`
   _Fail if:_ the summary still says none are done — `text summary ~ "0 done"`

6. **The summary reflects the work**
   `scroll summary`
   _Prove:_ three tasks, one of them done — `text summary ~ /3 tasks · 1 done/`

## Scrutiny

- The counts come from the app's screen, read through Appium, not from text hard-coded in the captions.
- Completing a task is reversible — tapping it again marks it to do and the count drops back.
- Nothing is persisted: a relaunch starts the board empty again.
