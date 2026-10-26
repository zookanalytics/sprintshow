# Demo: Sprint board — by keyboard alone

**Start:** `/`

The bundled sample app, driven with keys only: Tab and Shift+Tab move focus, Enter presses
the control that has it, and Escape closes a dialog. The page's own focus ring shows where
focus is, and each step checks it against the live page.

## Steps

1. **Tab moves focus into the new-task field**
   `waitFor #board`
   `press Tab`
   _Prove:_ the field has focus — `focused #new-task`

2. **Typing a title and pressing Enter adds the task**
   `press "Ship the demo engine" Enter`
   _Prove:_ one task is on the board — `count .task == 1`

3. **Tab passes Add and reaches the task's Done button**
   `press Tab Tab`
   _Prove:_ the task's Done button has focus — `focused .task .done-btn`

4. **Enter presses Done, and the task is marked done**
   `press Enter`
   _Prove:_ one task reads as done — `count .task.done == 1`

5. **Tab reaches Clear done, and Enter opens its dialog**
   `press Tab Enter`
   _Prove:_ focus moved into the dialog, onto Cancel — `focused #confirm-cancel`

6. **Escape closes the dialog, and focus returns to Clear done**
   `press Escape`
   _Prove:_ focus is back on the button that opened the dialog — `focused #clear-done`
   _Fail if:_ the done task was removed — `count .task == 0`

7. **Shift+Tab steps back to the task, and Enter undoes it**
   `press Shift+Tab Enter`
   _Prove:_ no task reads as done — `count .task.done == 0`

## Scrutiny

- The focus ring is the page's own, and the pointer never moves: every step is a key press.
- Escape hands focus back to the button that opened the dialog, so the keyboard user is not stranded.
- Each proof reads focus or the board from the live page, not from the captions.
