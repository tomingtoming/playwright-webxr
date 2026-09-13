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
import { installRuntime, readDiagnostics, runSessionOperation } from './runtime.mjs';

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
  async enterVR({ button, force = false, timeout = 10_000 } = {}) {
    checkTimeout(timeout);
    const deadline = Date.now() + timeout;
    const remaining = () => Math.max(1, deadline - Date.now());
    const candidates = button
      ? [button]
      : ['#VRButton', 'button:has-text("ENTER VR")', 'text=/enter vr/i'];
    let target;
    while (!target && Date.now() < deadline) {
      for (const selector of candidates) {
        const locator = this.page.locator(selector);
        // A hidden first match must not mask a later visible entry button.
        for (let i = 0, count = await locator.count(); i < count; i++) {
          if (await locator.nth(i).isVisible()) {
            target = locator.nth(i);
            break;
          }
        }
        if (target) break;
      }
      if (!target) await this.page.waitForTimeout(Math.min(50, remaining()));
    }
    if (!target) {
      const counts = await Promise.all(candidates.map(selector => this.page.locator(selector).count()));
      const reason = counts.some(Boolean) ? 'VR button found but not visible' : 'no VR button found';
      throw new Error(`enterVR: ${reason} within ${timeout}ms (tried: ${candidates.join(', ')})`);
    }
    const after = await this.sessionCursor();
    try {
      await target.click({ force, timeout: remaining() });
    } catch (error) {
      throw new Error(`enterVR: VR button click failed: ${error.message}`, { cause: error });
    }
    let handle;
    try {
      handle = await this.page.waitForFunction(after => {
        return (globalThis.__xrSessionLog ?? []).find(entry =>
          entry.sequence > after && entry.mode === 'immersive-vr' &&
          (entry.event === 'granted' || entry.event === 'rejected'));
      }, after, { timeout: remaining() });
    } catch (error) {
      throw new Error(`enterVR: no new immersive-vr session granted or rejected within ${timeout}ms`, { cause: error });
    }
    const outcome = await handle.jsonValue();
    await handle.dispose();
    if (outcome.event === 'rejected') {
      throw new Error(`enterVR: session request ${outcome.requestId} rejected: ${outcome.detail}`);
    }
    const isCurrent = await this.page.evaluate(id => {
      const active = globalThis.__xrDevice?.activeSession;
      const record = active && globalThis.__pwWebXR?.sessions.get(active);
      return record?.sessionId === id && !record.ended;
    }, outcome.sessionId);
    if (!isCurrent) {
      throw new Error(`enterVR: ${outcome.sessionId} was granted but is no longer active; inspect sessionLog()`);
    }
  }

  /** Wait until an XRSession is live on the emulated device. */
  async waitForSession(timeout = 10_000) {
    const handle = await this.page.waitForFunction(() => {
      const session = globalThis.__xrDevice?.activeSession;
      return session && !globalThis.__pwWebXR?.sessions.get(session)?.ended;
    }, undefined, { timeout });
    await handle.dispose();
  }

  /** End the current session and wait for both end() and its end event. */
  async endSession({ sessionId, timeout = 10_000 } = {}) {
    checkTimeout(timeout);
    checkSessionId(sessionId);
    return this.page.evaluate(runSessionOperation, { operation: 'endSession', sessionId, timeout });
  }

  /** Wait for new XR animation frames on the current session, not app readiness. */
  async waitForFrames(count, { sessionId, timeout = 10_000 } = {}) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('waitForFrames: count must be a non-negative safe integer');
    }
    checkTimeout(timeout);
    checkSessionId(sessionId);
    return this.page.evaluate(runSessionOperation, { operation: 'waitForFrames', count, sessionId, timeout });
  }

  /** Lifecycle history for this document; sequence and IDs reset on navigation. */
  async sessionLog() {
    return this.page.evaluate(() => globalThis.__xrSessionLog ?? []);
  }

  /** Save before an action; use { after: cursor } to wait only for newer events. */
  async sessionCursor() {
    return this.page.evaluate(() => globalThis.__pwWebXR?.sequence ?? 0);
  }

  /**
   * Wait for lifecycle history, including short-lived sessions. The numeric
   * timeout overload remains supported. after is exclusive; sessionId filters
   * granted/end/end-called events (requests and rejections have no session).
   */
  async waitForSessionEvent(event, options = {}) {
    const { timeout = 30_000, after = 0, sessionId } =
      typeof options === 'number' ? { timeout: options } : options;
    const handle = await this.page.waitForFunction(({ event, after, sessionId }) => {
      const matches = (globalThis.__xrSessionLog ?? []).filter(entry =>
        entry.event === event && entry.sequence > after &&
        (sessionId === undefined || entry.sessionId === sessionId));
      return matches.length ? matches : false;
    }, { event, after, sessionId }, { timeout });
    const matches = await handle.jsonValue();
    await handle.dispose();
    return matches;
  }

  async sessionMode() {
    return this.page.evaluate(() => {
      const session = globalThis.__xrDevice?.activeSession;
      const record = session && globalThis.__pwWebXR?.sessions.get(session);
      return session && !record?.ended ? (record?.mode ?? 'unknown-session') : null;
    });
  }

  /** Sample the active session, selected canvas, GPU and base-layer eye viewports. */
  async diagnostics({ canvas = 'canvas', timeout = 2_000 } = {}) {
    checkTimeout(timeout);
    const result = await this.page.evaluate(readDiagnostics, { canvas, timeout });
    // IWER can override navigator.userAgent to a Quest profile. The browser's
    // actual version must come from Playwright, not that emulated string.
    result.runtime.browserVersion = this.page.context().browser()?.version() ?? null;
    return result;
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
  async screenshot(path, { canvas = 'canvas', timeout = 5_000, metadata = false } = {}) {
    checkTimeout(timeout);
    const capture = await this.page.evaluate(({ selector, timeout }) => new Promise((resolve, reject) => {
      const target = document.querySelector(selector);
      if (!(target instanceof HTMLCanvasElement)) {
        reject(new Error(`screenshot: no canvas matches ${selector}`));
        return;
      }
      let frameId;
      const timer = setTimeout(() => {
        cancelAnimationFrame(frameId);
        reject(new Error(`screenshot: timed out waiting for a frame (${selector})`));
      }, timeout);
      frameId = requestAnimationFrame(() => {
        clearTimeout(timer);
        try {
          const dataUrl = target.toDataURL('image/png');
          if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('canvas has no encodable pixels');
          const active = globalThis.__xrDevice?.activeSession;
          resolve({
            dataUrl, width: target.width, height: target.height, canvas: selector,
            sessionId: active ? globalThis.__pwWebXR?.sessions.get(active)?.sessionId ?? null : null,
            capture: 'canvas',
          });
        } catch (error) {
          reject(new Error(`screenshot: cannot capture ${selector}: ${error.message}`));
        }
      });
    }), { selector: canvas, timeout });
    const { dataUrl, ...info } = capture;
    await fs.writeFile(path, Buffer.from(dataUrl.split(',')[1], 'base64'));
    // Keep the original return value unless metadata is explicitly requested.
    return metadata ? { path, ...info } : path;
  }

  /** Wait the specified milliseconds; does not guarantee frames or app readiness. */
  async settle(ms = 500) {
    await this.page.waitForTimeout(ms);
  }
}

function checkTimeout(timeout) {
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('timeout must be a positive finite number');
}

function checkSessionId(sessionId) {
  if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.trim())) {
    throw new Error('sessionId must be a non-empty string');
  }
}

export const test = base.extend({
  xrDeviceName: ['metaQuest3', { option: true }],
  xrStereoEnabled: [false, { option: true }],
  // null selects 0 for mono, 0.064 m for stereo; explicit values are preserved.
  xrIpd: [null, { option: true }],
  xr: async ({ page, xrDeviceName, xrStereoEnabled, xrIpd }, use) => {
    const ipd = xrIpd ?? (xrStereoEnabled ? 0.064 : 0);
    if (typeof xrStereoEnabled !== 'boolean') throw new Error('xrStereoEnabled must be a boolean');
    if (!Number.isFinite(ipd) || ipd < 0) throw new Error('xrIpd must be a non-negative finite number in meters');
    const versions = {
      playwrightWebxr: require('../package.json').version,
      iwer: require('iwer/package.json').version,
    };
    const source = await fs.readFile(require.resolve('iwer/build/iwer.min.js'), 'utf8');
    const options = { deviceName: xrDeviceName, stereoEnabled: xrStereoEnabled, ipd, versions };
    // Playwright does not define ordering across separate addInitScript calls.
    await page.addInitScript({ content: `${source}\n;(${installRuntime.toString()})(${JSON.stringify(options)});` });
    await use(new XRHandle(page));
  },
});

export { expect };
