// Seed-test bootstrap: prepare a page in a Playwright test — sign in, seed data, land on
// the right screen — then hand it to the engine. The engine owns neither the browser nor
// the server here; the test does. This is the path to take when a demo needs auth or
// fixtures the demo script cannot express.
//
// Requires @playwright/test and @zookanalytics/sprintshow. Run with `npx playwright test`.

import { test } from '@playwright/test';
import { captureProof } from '@zookanalytics/sprintshow';

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

test('demo: authenticated dashboard', async ({ page }) => {
  // 1. Arrange whatever the demo cannot: authenticate, seed fixtures, dismiss a banner.
  await page.goto(`${BASE_URL}/login`);
  await page.fill('#email', 'demo@example.com');
  await page.fill('#password', process.env.DEMO_PASSWORD ?? 'demo');
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard');

  // 2. Hand the ready page to the driver. The demo script's steps run from here; its
  //    `**Start:**` path is joined onto BASE_URL.
  const result = await captureProof({
    page,
    baseUrl: BASE_URL,
    demo: `${import.meta.dirname}/dashboard.md`,
    outputPath: 'demos/dashboard.mp4',
  });

  // 3. A failed proof means the demo showed a broken behaviour — fail the test on it.
  if (result.failures > 0) throw new Error(`${result.failures} demo step(s) failed their proof`);
});
