# Seed-test bootstrap

When a demo needs something the script cannot express — a login, seeded data, a dismissed
first-run banner — arrange it in a Playwright test and hand the ready page to the engine.
The test owns the browser and the server; the engine drives the demo from the page it is
given.

`captureProof` is the entry point for this path: it takes a `page`, a `baseUrl`, a demo
(path or parsed), and an `outputPath`, and returns `{ outputPath, narrated, failures, … }`.
A non-zero `failures` means a step's `_Prove:_` did not hold — fail the test on it and the
demo doubles as a check.

See [`example.spec.ts`](example.spec.ts). It expects `@playwright/test` and this package:

```bash
npm install -D @playwright/test @zookanalytics/sprintshow
npx playwright test examples/seed-test/example.spec.ts
```

The walkthrough (recorded) mode records at the context level, so it owns its own context
rather than borrowing your page. Use `captureWalkthrough({ baseUrl, demo, outputPath })`,
or the CLI, for that cut.
