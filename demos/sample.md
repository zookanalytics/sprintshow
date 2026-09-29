# Demo: Sprint board — add and complete tasks

**Start:** `/`

The board starts empty, takes tasks, and tracks how many are done — driven end to end
against the bundled sample app, with every step checked against the live DOM.

## Steps

1. **The board boots empty**
   `waitFor #board`
   The page loads straight into the board with its empty-state hint.
   _Prove:_ the empty-state hint is showing — `visible #empty-hint`
   _Fail if:_ a task somehow already exists — `count .task >= 1`

2. **Add the first task**
   `type #new-task ~ Ship the demo engine`
   `click #add`
   `wait 400`
   Typing a title and pressing Add appends a task and clears the field.
   _Prove:_ one task is rendered — `count .task >= 1`
   _Fail if:_ the empty hint is still visible — `visible #empty-hint`

3. **Add a second task**
   `type #new-task ~ Write the README`
   `click #add`
   `wait 400`
   _Prove:_ the list now holds two — `count .task >= 2`

4. **Add a third task**
   `type #new-task ~ Cut the first release`
   `click #add`
   `wait 400`
   _Prove:_ three tasks stand on the board — `count .task >= 3`
   _Fail if:_ the add did not register and the count is stuck at two — `text #summary ~ "2 tasks"`

5. **Mark the first task done**
   `click .task:first-child .done-btn`
   `wait 400`
   Completing a task strikes it through and updates the done count.
   _Prove:_ one task now reads as done — `count .task.done >= 1`
   _Fail if:_ the summary still says none are done — `text #summary ~ "0 done"`

6. **The summary reflects the work**
   `scroll #summary`
   `wait 300`
   _Prove:_ three tasks, one of them done — `text #summary ~ /3 tasks · 1 done/`

## Scrutiny

- The counts come from the live DOM, not from text hard-coded in the captions.
- Completing a task is reversible — the button flips to Undo and the count drops back.
- Nothing is persisted: a reload starts the board empty again.
