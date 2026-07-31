/**
 * ysflight-web staging: VR entry degradation on GPU-less runners.
 *
 * ysflight's VR menu phase requires the WebXR-layers + OVR_multiview2 chain
 * (menu quad creation is gated on vr.mvLayer); SwiftShader has no
 * OVR_multiview2, so on a GPU-less runner VR entry must degrade gracefully
 * back to the flat page. This spec pins the stable part of that contract:
 *
 *   1. "Play in VR" button appears (IWER answers isSessionSupported=true)
 *   2. clicking it gets a session granted, which the app then ends
 *      (VR not viable here) — within seconds
 *   3. the page returns to flat: the VR button is re-enabled (onVrEnd)
 *
 * OBSERVED (2026-07-29, build a74ed3b4315e): two distinct degradation paths
 * exist and neither leaves vr.endReason for the explanatory toast —
 *   - without layers polyfill: vr.enter()'s setup catch ends the session
 *     ~2ms after grant (sync throw right after updateRenderState; the
 *     rethrown error surfaces nowhere) → silent return to 2D, no toast
 *   - with IWER polyfillLayers: setup completes, rAF loop runs ~3s
 *     (~45 frames < the 100-frame watchdog), session ends, endReason null
 * The designed 'menu-unsupported' toast path was not reachable in either
 * mode. Real-GPU runs (OVR_multiview2 available) are the way to test the
 * actual menu phase; potential silent-exit UX gap reported upstream.
 *
 *   STAGING_URL=... npx playwright test tests/ysflight-staging.spec.mjs
 */
import { test, expect } from '../src/index.mjs';

const URL = process.env.STAGING_URL;
test.skip(!URL, 'project-specific dogfood: set STAGING_URL to run');

test('VR entry degrades gracefully back to flat on GPU-less runner', async ({ page, xr }) => {
  test.setTimeout(300_000);
  await page.goto(URL);

  // 1. VR button appears once IWER answers isSessionSupported=true
  const vrBtn = page
    .locator('button:has-text("VRでプレイ開始"), button:has-text("Play in VR")')
    .first();
  await vrBtn.waitFor({ state: 'visible', timeout: 120_000 });

  // 2. session granted on click, then ended by the app — assert on the
  //    fixture's event log (the session can be too short-lived for polling
  //    while the main thread is jammed by WASM boot)
  await vrBtn.click();
  await xr.waitForSessionEvent('granted', 60_000);
  await xr.waitForSessionEvent('end', 60_000);

  // 3. back to flat: session gone, no layers chain, VR button usable again
  const post = await page.evaluate(() => {
    const vr = globalThis.Module?.ysfwVr;
    return vr ? { mvLayer: !!vr.mvLayer, session: !!vr.session } : null;
  });
  expect(post).not.toBeNull();
  expect(post.session).toBe(false);
  expect(post.mvLayer).toBe(false);
  await expect(vrBtn).toBeEnabled({ timeout: 30_000 });
});
