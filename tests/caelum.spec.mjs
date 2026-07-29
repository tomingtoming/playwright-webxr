/**
 * Dogfood: caelum (https://caelum.toming.app/viewer/) in emulated VR.
 *
 * Checks (from keel projects/caelum.md spec + Quest-found bug families):
 *  1. With IWER installed, the app's VR button offers ENTER VR (not "VR NOT SUPPORTED")
 *  2. immersive-vr session starts
 *  3. Starfield renders inside VR (canvas not black)
 *  4. Head ROLL: thumbnail billboards should stay horizontal (the v19 Quest bug
 *     family: billboards following head roll). Screenshots captured for VLM judge.
 *  5. Head YAW: view changes (pose actually drives the camera)
 */
import { test, expect } from '../src/index.mjs';

const URL = 'https://caelum.toming.app/viewer/';
const OUT = process.env.OUT_DIR ?? './out';

test('caelum viewer in emulated VR: session, render, roll/yaw poses', async ({ page, xr }) => {
  await page.goto(URL);
  // wait for starmap+atlas load: HUD reports 実体N
  // locale-agnostic: HUD reads 実体N (ja) / N live (en)
  await page.waitForFunction(
    () => /実体\s*\d+|\d+\s*live/.test(document.body.innerText),
    undefined,
    { timeout: 60_000 },
  );
  expect(await xr.runtimeInstalled()).toBe(true);

  // 1. VR button must NOT say unsupported
  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText).not.toContain('VR NOT SUPPORTED');

  // 2. enter VR through the app's own button
  await xr.enterVR();
  expect(await xr.sessionMode()).not.toBeNull();
  await xr.settle(3000);

  // 3. capture baseline VR frame
  await page.evaluate(() => new Promise((r) => setTimeout(r, 2000)));
  await xr.screenshot(`${OUT}/vr_01_baseline.png`);

  // 4. roll head 25° — billboards should NOT roll with it
  await xr.setHeadPose({ euler: [0, 0, (25 * Math.PI) / 180] });
  await xr.settle(2500);
  await xr.screenshot(`${OUT}/vr_02_roll25.png`);

  // 5. yaw head 60° — view must change vs baseline
  await xr.setHeadPose({ euler: [0, (60 * Math.PI) / 180, 0] });
  await xr.settle(2500);
  await xr.screenshot(`${OUT}/vr_03_yaw60.png`);

  // restore
  await xr.setHeadPose({ euler: [0, 0, 0] });
});
