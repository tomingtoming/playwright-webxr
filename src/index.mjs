/**
 * playwright-webxr — Playwright fixture for testing WebXR apps in CI
 * via IWER (Meta's Immersive Web Emulation Runtime).
 *
 * MVP surface:
 *   import { test, expect } from 'playwright-webxr';
 *   test('vr', async ({ page, xr }) => {
 *     await page.goto(url);
 *     await xr.enterVR();              // clicks the app's VR button
 *     await xr.setHeadPose({ euler: [0, 0, 0.4] });  // roll the head
 *     await xr.screenshot('rolled.png');
 *   });
 */
import { test as base, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';

const require = createRequire(import.meta.url);

export class XRHandle {
  constructor(page) {
    this.page = page;
  }

  /** True once IWER's runtime has replaced navigator.xr on the page. */
  async runtimeInstalled() {
    return this.page.evaluate(() => !!globalThis.__xrDevice);
  }

  /**
   * Enter an immersive-vr session by clicking the app's own VR button
   * (honest E2E path: user gesture → requestSession). Pass a selector or
   * button text; defaults cover three.js VRButton and common variants.
   */
  async enterVR({ button } = {}) {
    const candidates = button
      ? [button]
      : ['#VRButton', 'button:has-text("ENTER VR")', 'text=/enter vr/i'];
    for (const sel of candidates) {
      const loc = this.page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ force: true });
        await this.waitForSession();
        return;
      }
    }
    throw new Error(`enterVR: no VR button found (tried: ${candidates.join(', ')})`);
  }

  /** Wait until an XRSession is live on the emulated device. */
  async waitForSession(timeout = 10_000) {
    await this.page.waitForFunction(
      () => globalThis.__xrDevice?.activeSession != null,
      undefined,
      { timeout },
    );
  }

  /** Session lifecycle events recorded since page init (see fixture). */
  async sessionLog() {
    return this.page.evaluate(() => globalThis.__xrSessionLog ?? []);
  }

  /**
   * Wait for a session lifecycle EVENT ('request'|'granted'|'end'|'rejected').
   * Robust for short-lived sessions that end before state polling can see
   * them (event log survives the session).
   */
  async waitForSessionEvent(event, timeout = 30_000) {
    await this.page.waitForFunction(
      (ev) => (globalThis.__xrSessionLog ?? []).some((e) => e.event === ev),
      event,
      { timeout },
    );
    return (await this.sessionLog()).filter((e) => e.event === event);
  }

  async sessionMode() {
    return this.page.evaluate(() => {
      const s = globalThis.__xrDevice?.activeSession;
      return s ? (s.mode ?? 'unknown-session') : null;
    });
  }

  /**
   * Set headset pose. position: [x,y,z] meters. euler: [pitchX, yawY, rollZ]
   * radians (XYZ order, applied in local axes like a human head).
   */
  async setHeadPose({ position, euler, quaternion } = {}) {
    await this.page.evaluate(
      ({ position, euler, quaternion }) => {
        const d = globalThis.__xrDevice;
        if (!d) throw new Error('IWER device missing');
        if (position) d.position.set(position[0], position[1], position[2]);
        let q = quaternion;
        if (!q && euler) {
          const [x, y, z] = euler;
          const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
          const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
          const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
          // XYZ intrinsic order
          q = [
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
          ];
        }
        if (q) d.quaternion.set(q[0], q[1], q[2], q[3]);
      },
      { position, euler, quaternion },
    );
  }

  /** Move / orient a controller. hand: 'left' | 'right'. */
  async setControllerPose(hand, { position, quaternion } = {}) {
    await this.page.evaluate(
      ({ hand, position, quaternion }) => {
        const c = globalThis.__xrDevice?.controllers?.[hand];
        if (!c) throw new Error(`no ${hand} controller`);
        if (position) c.position.set(position[0], position[1], position[2]);
        if (quaternion) c.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      },
      { hand, position, quaternion },
    );
  }

  /** Press and release a controller button (e.g. 'trigger', 'a-button'). */
  async pressButton(hand, button, { holdMs = 120 } = {}) {
    await this.page.evaluate(
      ({ hand, button }) => {
        globalThis.__xrDevice.controllers[hand].updateButtonValue(button, 1);
      },
      { hand, button },
    );
    await this.page.waitForTimeout(holdMs);
    await this.page.evaluate(
      ({ hand, button }) => {
        globalThis.__xrDevice.controllers[hand].updateButtonValue(button, 0);
      },
      { hand, button },
    );
  }

  /** Push an analog axis value (thumbstick): axis 2=x, 3=y on Quest profile. */
  async setAxes(hand, x, y) {
    await this.page.evaluate(
      ({ hand, x, y }) => {
        const c = globalThis.__xrDevice.controllers[hand];
        c.updateAxes('thumbstick', x, y);
      },
      { hand, x, y },
    );
  }

  /**
   * Screenshot the WebGL canvas via toDataURL (robust where page.screenshot
   * times out on continuously-rendering canvases / software GL).
   */
  async screenshot(path) {
    const dataUrl = await this.page.evaluate(
      () =>
        new Promise((res) => {
          const c = document.querySelector('canvas');
          if (!c) return res(null);
          requestAnimationFrame(() => res(c.toDataURL('image/png')));
        }),
    );
    if (!dataUrl) throw new Error('screenshot: no canvas');
    const b64 = dataUrl.split(',')[1];
    await fs.writeFile(path, Buffer.from(b64, 'base64'));
    return path;
  }

  /** Advance N animation frames then settle (for stepping deterministic-ish). */
  async settle(ms = 500) {
    await this.page.waitForTimeout(ms);
  }
}

export const test = base.extend({
  xrDeviceName: ['metaQuest3', { option: true }],
  xr: async ({ page, xrDeviceName }, use) => {
    await page.addInitScript({ path: require.resolve('iwer/build/iwer.min.js') });
    await page.addInitScript(
      ([deviceName]) => {
        const { XRDevice } = globalThis.IWER;
        const config = globalThis.IWER[deviceName];
        const device = new XRDevice(config);
        // forceInstall: headless Chromium exposes a stub navigator.xr (always
        // "not supported"); IWER >=2.3 silently refuses to clobber it otherwise.
        device.installRuntime({ forceInstall: true });
        // Event log for session lifecycle: short-lived sessions (an app may
        // end one within seconds) can outrun state polling when the main
        // thread is jammed (e.g. WASM boot). Record transitions instead.
        globalThis.__xrSessionLog = [];
        const log = (event, detail) =>
          globalThis.__xrSessionLog.push({ event, detail: detail ?? null, t: performance.now() | 0 });
        const sys = navigator.xr;
        const origRequest = sys.requestSession.bind(sys);
        sys.requestSession = (mode, init) => {
          log('request', mode);
          return origRequest(mode, init).then(
            (session) => {
              log('granted', mode);
              // This listener is registered before the app ever sees the
              // session, so at 'end' it runs ahead of app cleanup — the spec
              // can define globalThis.__xrEndProbe to snapshot app state
              // (e.g. an end-reason field) before the app consumes/resets it.
              session.addEventListener(
                'end',
                () => {
                  let detail = null;
                  try {
                    detail = globalThis.__xrEndProbe ? globalThis.__xrEndProbe() : null;
                  } catch (e) {
                    detail = 'probe threw: ' + e.message;
                  }
                  log('end', detail);
                },
                { once: true },
              );
              // Who ends the session? Record the call stack — degradation
              // paths are impossible to tell apart from the 'end' event alone.
              const origEnd = session.end.bind(session);
              session.end = () => {
                log('end-called', String(new Error().stack).split('\n').slice(1, 5).join(' <- '));
                return origEnd();
              };
              return session;
            },
            (err) => {
              log('rejected', String(err));
              throw err;
            },
          );
        };
        device.stereoEnabled = false; // mono render → screenshots judgeable as one image
        device.ipd = 0;
        globalThis.__xrDevice = device;
      },
      [xrDeviceName],
    );
    await use(new XRHandle(page));
  },
});

export { expect };
