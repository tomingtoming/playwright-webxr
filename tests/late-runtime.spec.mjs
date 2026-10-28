import fs from 'node:fs/promises';
import { test, expect } from '../src/index.mjs';

const world = await fs.readFile(new URL('./fixtures/world.html', import.meta.url), 'utf8');

// The trap: a beforeEach that navigates without requesting xr.
test.beforeEach(async ({ page }) => {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: world }));
  await page.goto('https://xr.test/');
});

test('a runtime missing because xr was requested after navigation is explained', async ({ page, xr }) => {
  expect(await xr.runtimeInstalled()).toBe(false);
  await expect(xr.setControllerPose('right', { position: [0, 1, 0] }))
    .rejects.toThrow(/first requested after the page had already navigated to https:\/\/xr\.test\/.*before page\.goto\(\)/s);
  await page.reload();
  expect(await xr.runtimeInstalled()).toBe(true);
});
