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
import { installRuntime, readDiagnostics, readXRState, runInputScript, runSessionOperation } from './runtime.mjs';
import { composePose, invertPose, poseFromMatrix, quatMultiply, rotateVector, transformPoint } from './pose.mjs';

const require = createRequire(import.meta.url);

const HANDS = ['left', 'right'];
const FLICK = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

export class XRHandle {
  constructor(page, { lateUrl = null } = {}) {
    this.page = page;
    this.lateUrl = lateUrl;
  }

  /** Explain the common reason the emulated device is missing. */
  missingRuntime(error) {
    const late = this.lateUrl
      ? ` The xr fixture was first requested after the page had already navigated to ${this.lateUrl}.`
      : '';
    return new Error(`${error.message}: the IWER runtime is not installed in this document.${late} ` +
      'The runtime is added with page.addInitScript(), which only affects documents loaded after the ' +
      'xr fixture is first requested. Request xr (for example, test.beforeEach(async ({ page, xr }) => ...)) ' +
      'before page.goto(), or reload the page.', { cause: error });
  }

  async evaluate(fn, arg) {
    try {
      return await this.page.evaluate(fn, arg);
    } catch (error) {
      if (/IWER device missing/.test(error.message)) throw this.missingRuntime(error);
      throw error;
    }
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
    await this.evaluate(
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

  /**
   * Move / orient a controller's target ray. hand: 'left' | 'right'.
   * Use setGripPose() to place the grip (the point a hand holds) instead.
   */
  async setControllerPose(hand, { position, quaternion } = {}) {
    checkHand(hand);
    await this.evaluate(
      ({ hand, position, quaternion }) => {
        const d = globalThis.__xrDevice;
        if (!d) throw new Error('IWER device missing');
        const c = d.controllers?.[hand];
        if (!c) throw new Error(`no ${hand} controller`);
        if (position) c.position.set(position[0], position[1], position[2]);
        if (quaternion) c.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
      },
      { hand, position, quaternion },
    );
  }

  /**
   * Current controller poses in tracking space: target ray and grip, as IWER
   * computes the grip from the device profile's grip offset.
   */
  async controllerPose(hand) {
    checkHand(hand);
    const state = await this.evaluate(readXRState, { views: false });
    const c = state.controllers[hand];
    if (!c) throw new Error(`controllerPose: no ${hand} controller`);
    const targetRay = { position: c.position, quaternion: c.quaternion };
    const grip = c.gripOffsetMatrix ? composePose(targetRay, poseFromMatrix(c.gripOffsetMatrix)) : null;
    return { targetRay, grip, connected: c.connected };
  }

  /**
   * Place the controller so its grip is at { position, quaternion }. Without
   * a quaternion, the current target-ray orientation is kept and only the
   * grip point moves; the profile's grip offset rotates with the hand.
   */
  async setGripPose(hand, { position, quaternion } = {}) {
    checkHand(hand);
    const pose = await this.targetRayForGrip(hand, { position, quaternion });
    await this.setControllerPose(hand, pose);
    return pose;
  }

  async targetRayForGrip(hand, { position, quaternion }) {
    if (position !== undefined) checkVector(position, 'position');
    if (quaternion !== undefined) checkQuaternion(quaternion);
    const state = await this.evaluate(readXRState, { views: false });
    const c = state.controllers[hand];
    if (!c) throw new Error(`no ${hand} controller`);
    if (!c.gripOffsetMatrix) throw new Error(`${hand} controller profile has no grip offset`);
    const offset = poseFromMatrix(c.gripOffsetMatrix);
    // grip = targetRay * offset  =>  targetRay = grip * offset^-1
    const inverse = invertPose(offset);
    const currentGrip = composePose({ position: c.position, quaternion: c.quaternion }, offset);
    const rayQuaternion = quaternion ? quatMultiply(quaternion, inverse.quaternion) : c.quaternion;
    const gripPosition = position ?? currentGrip.position;
    const lever = rotateVector(rayQuaternion, offset.position);
    return { position: gripPosition.map((v, i) => v - lever[i]), quaternion: rayQuaternion };
  }

  /**
   * Hold a button down until released. Resolves after IWER has applied the
   * value in `frames` XR frames (default 1), so the app can observe it.
   */
  async hold(hand, button, { value = 1, frames = 1, sessionId, timeout = 10_000 } = {}) {
    checkHand(hand);
    if (!(value > 0 && value <= 1)) throw new Error('hold: value must be in (0, 1]');
    checkFrames(frames, 'hold', 1);
    return this.input('hold', [
      { type: 'button', hand, button, value },
      { type: 'frames', count: frames },
    ], { sessionId, timeout });
  }

  /** Release a held button; resolves after IWER has applied the release. */
  async release(hand, button, { frames = 1, sessionId, timeout = 10_000 } = {}) {
    checkHand(hand);
    checkFrames(frames, 'release', 1);
    return this.input('release', [
      { type: 'button', hand, button, value: 0 },
      { type: 'frames', count: frames },
    ], { sessionId, timeout });
  }

  /**
   * Press and release a controller button (e.g. 'trigger', 'a-button'). The
   * press lasts at least holdMs AND at least `frames` XR frames, then the
   * release is applied in a further frame. A slow page cannot drop it.
   */
  async pressButton(hand, button, { holdMs = 120, frames = 2, sessionId, timeout = 10_000 } = {}) {
    checkHand(hand);
    checkMs(holdMs, 'holdMs');
    checkFrames(frames, 'pressButton', 1);
    return this.input('pressButton', [
      { type: 'button', hand, button, value: 1 },
      { type: 'frames', count: frames, minMs: holdMs },
      { type: 'button', hand, button, value: 0 },
      { type: 'frames', count: 1 },
    ], { sessionId, timeout });
  }

  /**
   * Grab, move along a straight path and release in one frame-driven run.
   * from/to are target-ray positions, or grip positions with space: 'grip'.
   * The path takes at least `ms` and at least `steps` XR frames.
   */
  async drag(hand, {
    from, to, ms = 300, steps = 5, button = 'squeeze', quaternion, toQuaternion,
    space = 'targetRay', release = true, settleFrames = 2, sessionId, timeout,
  } = {}) {
    checkHand(hand);
    checkVector(from, 'from');
    checkVector(to, 'to');
    checkMs(ms, 'ms');
    checkFrames(steps, 'drag', 1);
    checkFrames(settleFrames, 'drag', 1);
    if (!['targetRay', 'grip'].includes(space)) throw new Error("drag: space must be 'targetRay' or 'grip'");
    if (toQuaternion && !quaternion) throw new Error('drag: toQuaternion requires quaternion');
    let start = { position: from, quaternion };
    let end = { position: to, quaternion: toQuaternion ?? quaternion };
    if (space === 'grip') {
      start = await this.targetRayForGrip(hand, start);
      end = await this.targetRayForGrip(hand, { position: to, quaternion: toQuaternion ?? quaternion });
    }
    const steps_ = [
      { type: 'pose', hand, position: start.position, quaternion: start.quaternion },
      { type: 'frames', count: 1 },
      { type: 'button', hand, button, value: 1 },
      { type: 'frames', count: 1 },
      {
        type: 'move', hand, from: start.position, to: end.position, ms, steps,
        fromQuaternion: start.quaternion ?? null, toQuaternion: end.quaternion ?? null,
      },
      // Hold the end pose so apps that follow the hand a frame late still arrive.
      { type: 'frames', count: settleFrames },
    ];
    if (release) steps_.push({ type: 'button', hand, button, value: 0 }, { type: 'frames', count: 1 });
    return this.input('drag', steps_, { sessionId, timeout: timeout ?? Math.max(10_000, ms * 4) });
  }

  /** Push an analog axis value (thumbstick) immediately; it stays until changed. */
  async setAxes(hand, x, y) {
    checkHand(hand);
    await this.evaluate(
      ({ hand, x, y }) => {
        const d = globalThis.__xrDevice;
        if (!d) throw new Error('IWER device missing');
        d.controllers[hand].updateAxes('thumbstick', x, y);
      },
      { hand, x, y },
    );
  }

  /**
   * Hold the thumbstick at (x, y) for at least ms and `frames` XR frames, then
   * return it to centre and wait one frame. Use for repeat-rate behaviour.
   */
  async holdAxes(hand, x, y, { ms = 0, frames = 2, axes = 'thumbstick', release = true, sessionId, timeout } = {}) {
    checkHand(hand);
    checkAxis(x);
    checkAxis(y);
    checkMs(ms, 'ms');
    checkFrames(frames, 'holdAxes', 1);
    const steps = [
      { type: 'axes', hand, axes, x, y },
      { type: 'frames', count: frames, minMs: ms },
    ];
    if (release) steps.push({ type: 'axes', hand, axes, x: 0, y: 0 }, { type: 'frames', count: 1 });
    return this.input('holdAxes', steps, { sessionId, timeout: timeout ?? Math.max(10_000, ms * 4) });
  }

  /**
   * One short thumbstick tilt: 'left' | 'right' | 'up' | 'down' ('up' is y = -1,
   * as on the WebXR gamepad). Held for `frames` XR frames, then centred.
   */
  async flick(hand, direction, { magnitude = 1, frames = 2, ms = 0, sessionId, timeout } = {}) {
    const vector = FLICK[direction];
    if (!vector) throw new Error(`flick: direction must be one of ${Object.keys(FLICK).join(', ')}`);
    if (!(magnitude > 0 && magnitude <= 1)) throw new Error('flick: magnitude must be in (0, 1]');
    return this.holdAxes(hand, vector[0] * magnitude, vector[1] * magnitude, { frames, ms, sessionId, timeout });
  }

  /**
   * Disconnect a controller (sleep, battery, tracking loss). Resolves after
   * the XR frame in which the session's input sources changed.
   */
  async disconnect(hand, { sessionId, timeout = 10_000 } = {}) {
    checkHand(hand);
    return this.input('disconnect', [
      { type: 'connected', hand, value: false },
      { type: 'frames', count: 1 },
    ], { sessionId, timeout });
  }

  async reconnect(hand, { sessionId, timeout = 10_000 } = {}) {
    checkHand(hand);
    return this.input('reconnect', [
      { type: 'connected', hand, value: true },
      { type: 'frames', count: 1 },
    ], { sessionId, timeout });
  }

  /**
   * Haptic pulses the app requested in this document, oldest first:
   * [{ sequence, hand, actuator, value, duration, t }]. Filter by hand and/or
   * by { after: cursor } (exclusive), with the cursor from hapticsCursor().
   */
  async haptics(hand, options = {}) {
    // haptics({ after }) is the hand-less form.
    if (typeof hand === 'object' && hand !== null) [hand, options] = [undefined, hand];
    const { after = 0 } = options;
    if (hand !== undefined) checkHand(hand);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('haptics: after must be a non-negative integer cursor');
    return this.evaluate(({ hand, after }) => {
      const state = globalThis.__pwWebXR;
      if (!state) throw new Error('IWER device missing');
      return state.haptics.filter(entry => entry.sequence > after && (hand === undefined || entry.hand === hand));
    }, { hand, after });
  }

  /** Save before an action; pass to haptics({ after }) to see only newer pulses. */
  async hapticsCursor() {
    return this.evaluate(() => {
      const state = globalThis.__pwWebXR;
      if (!state) throw new Error('IWER device missing');
      return state.haptics.length;
    });
  }

  /**
   * Project a tracking-space point through one XR frame's view. Returns NDC,
   * whether it is inside the view frustum, its canvas pixel (top-left origin)
   * when the base layer viewport is known, the angle from the view axis, and
   * the pixels per degree at the view centre.
   */
  async projectPoint(point, { eye, timeout = 2_000 } = {}) {
    checkVector(point, 'point');
    checkTimeout(timeout);
    const state = await this.evaluate(readXRState, { timeout });
    if (!state.views) throw new Error(`projectPoint: ${state.viewsReason}`);
    const view = eye ? state.views.find(v => v.eye === eye)
      : state.views.find(v => v.viewport?.width > 0) ?? state.views[0];
    if (!view) throw new Error(`projectPoint: no ${eye} view (have: ${state.views.map(v => v.eye).join(', ')})`);
    const eyePose = composePose(state.head, view);
    const local = composePoseInverseApply(eyePose, point);
    const [cx, cy, cz, cw] = transformPoint(view.projectionMatrix, local);
    const ndc = [cx / cw, cy / cw, cz / cw];
    const inView = cw > 0 && ndc.every(c => c >= -1 && c <= 1);
    const vp = view.viewport;
    const pixel = vp && vp.width > 0 && view.canvasHeight != null ? [
      vp.x + (ndc[0] + 1) / 2 * vp.width,
      view.canvasHeight - (vp.y + (ndc[1] + 1) / 2 * vp.height),
    ] : null;
    const degreesFromCenter = Math.acos(Math.max(-1, Math.min(1, -local[2] / Math.hypot(...local)))) * 180 / Math.PI;
    const pixelsPerDegree = vp && vp.height > 0 ? vp.height / 2 * view.projectionMatrix[5] * Math.PI / 180 : null;
    return { eye: view.eye, ndc, inView, behind: cw <= 0, pixel, degreesFromCenter, pixelsPerDegree, viewport: vp };
  }

  /**
   * Run a timed input script in one frame-driven page evaluation. Steps:
   *   { button: [hand, id, value] }          write a button value
   *   { axes: [hand, x, y], id? }             write a thumbstick (or other axes)
   *   { pose: hand, position?, quaternion? }  place a target ray
   *   { connected: [hand, boolean] }          connect / disconnect
   *   { frames: n, ms? }                      wait n XR frames and at least ms
   *   { wait: ms }                            wait at least ms (checked each XR frame)
   * Values take effect at the start of the next XR frame; add a frames/wait
   * step after a value you need the app to observe.
   */
  async sequence(steps, { sessionId, timeout = 10_000 } = {}) {
    if (!Array.isArray(steps) || steps.length === 0) throw new Error('sequence: steps must be a non-empty array');
    return this.input('sequence', steps.map((step, i) => toStep(step, i)), { sessionId, timeout });
  }

  async input(operation, steps, { sessionId, timeout }) {
    checkSessionId(sessionId);
    checkTimeout(timeout);
    return this.evaluate(runInputScript, { operation, steps, sessionId, timeout });
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

function checkHand(hand) {
  if (!HANDS.includes(hand)) throw new Error(`hand must be 'left' or 'right' (got ${JSON.stringify(hand)})`);
}

function checkVector(v, name) {
  if (!Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite)) {
    throw new Error(`${name} must be [x, y, z] finite numbers`);
  }
}

function checkQuaternion(q) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite) || Math.hypot(...q) < 1e-9) {
    throw new Error('quaternion must be [x, y, z, w] finite numbers, not all zero');
  }
}

function checkAxis(v) {
  if (!Number.isFinite(v) || v < -1 || v > 1) throw new Error('axis values must be within [-1, 1]');
}

function checkMs(ms, name) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} must be a non-negative finite number`);
}

function checkFrames(frames, operation, min = 0) {
  if (!Number.isSafeInteger(frames) || frames < min) throw new Error(`${operation}: frames must be an integer >= ${min}`);
}

function toStep(step, index) {
  const at = `sequence: step ${index + 1}`;
  const keys = ['button', 'axes', 'pose', 'connected', 'frames', 'wait'].filter(key => step && key in step);
  if (keys.length !== 1) throw new Error(`${at} must have exactly one of button, axes, pose, connected, frames, wait`);
  const [key] = keys;
  if (key === 'button') {
    const [hand, button, value] = step.button;
    checkHand(hand);
    if (!(value >= 0 && value <= 1)) throw new Error(`${at}: button value must be within [0, 1]`);
    return { type: 'button', hand, button, value };
  }
  if (key === 'axes') {
    const [hand, x, y] = step.axes;
    checkHand(hand);
    checkAxis(x);
    checkAxis(y);
    return { type: 'axes', hand, axes: step.id ?? 'thumbstick', x, y };
  }
  if (key === 'pose') {
    checkHand(step.pose);
    if (step.position !== undefined) checkVector(step.position, `${at}: position`);
    if (step.quaternion !== undefined) checkQuaternion(step.quaternion);
    return { type: 'pose', hand: step.pose, position: step.position, quaternion: step.quaternion };
  }
  if (key === 'connected') {
    const [hand, value] = step.connected;
    checkHand(hand);
    if (typeof value !== 'boolean') throw new Error(`${at}: connected value must be a boolean`);
    return { type: 'connected', hand, value };
  }
  if (key === 'frames') {
    checkFrames(step.frames, at);
    checkMs(step.ms ?? 0, `${at}: ms`);
    return { type: 'frames', count: step.frames, minMs: step.ms ?? 0 };
  }
  checkMs(step.wait, `${at}: wait`);
  return { type: 'frames', count: 0, minMs: step.wait };
}

function composePoseInverseApply(pose, point) {
  const inverse = invertPose(pose);
  const rotated = rotateVector(inverse.quaternion, point);
  return rotated.map((c, i) => c + inverse.position[i]);
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
    // addInitScript only reaches documents loaded from now on; remember a
    // late request so a missing runtime can be explained instead of guessed.
    const url = page.url();
    const lateUrl = url && url !== 'about:blank' ? url : null;
    await page.addInitScript({ content: `${source}\n;(${installRuntime.toString()})(${JSON.stringify(options)});` });
    await use(new XRHandle(page, { lateUrl }));
  },
});

export { expect };
