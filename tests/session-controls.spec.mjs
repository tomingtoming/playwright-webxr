import fs from 'node:fs/promises';
import { test, expect } from '../src/index.mjs';
import { aimQuaternion } from 'playwright-webxr/examples/aim-controller';

const world = await fs.readFile(new URL('./fixtures/world.html', import.meta.url), 'utf8');

test.beforeEach(async ({ page, xr }) => {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: world }));
  await page.goto('https://xr.test/');
  expect(await xr.runtimeInstalled()).toBe(true);
});

test('endSession observes synchronous end and app cleanup, then allows re-entry', async ({ page, xr }) => {
  await xr.enterVR();
  const [{ sessionId }] = await xr.waitForSessionEvent('granted');
  await page.evaluate(() => {
    window.session.addEventListener('end', () => { window.cleanedUp = true; });
  });
  expect(await xr.endSession({ sessionId })).toEqual({ sessionId });
  expect(await page.evaluate(() => window.cleanedUp)).toBe(true);
  expect(await xr.sessionMode()).toBeNull();
  expect((await xr.sessionLog()).filter(entry => entry.event === 'end').map(entry => entry.sessionId)).toEqual([sessionId]);
  await xr.enterVR();
  const second = await xr.endSession();
  expect(second.sessionId).not.toBe(sessionId);
});

test('session operations reject inactive, ended and stale IDs without ending a newer session', async ({ xr }) => {
  await expect(xr.endSession()).rejects.toThrow(/no active session/);
  await expect(xr.waitForFrames(1)).rejects.toThrow(/no active session/);
  await xr.enterVR();
  const { sessionId } = await xr.endSession();
  await expect(xr.endSession({ sessionId })).rejects.toThrow(/no active session/);
  await xr.enterVR();
  await expect(xr.endSession({ sessionId })).rejects.toThrow(/sessionId mismatch/);
  await expect(xr.waitForFrames(2, { sessionId })).rejects.toThrow(/sessionId mismatch/);
  expect(await xr.sessionMode()).toBe('immersive-vr');
  expect((await xr.sessionLog()).filter(entry => entry.event === 'end-called')).toHaveLength(1);
});

test('endSession waits for an asynchronous end event after end() resolves', async ({ page, xr }) => {
  await xr.enterVR();
  await page.evaluate(() => {
    const end = window.session.end.bind(window.session);
    window.session.end = () => {
      setTimeout(end, 80);
      return Promise.resolve();
    };
  });
  const { sessionId } = await xr.endSession();
  expect(await xr.sessionMode()).toBeNull();
  expect((await xr.sessionLog()).some(entry => entry.event === 'end' && entry.sessionId === sessionId)).toBe(true);
});

test('endSession also waits for end() to resolve after the event', async ({ page, xr }) => {
  await xr.enterVR();
  await page.evaluate(() => {
    const end = window.session.end.bind(window.session);
    window.session.end = async () => {
      await end();
      await new Promise(resolve => setTimeout(resolve, 80));
      window.endResolved = true;
    };
  });
  await xr.endSession();
  expect(await page.evaluate(() => window.endResolved)).toBe(true);
});

test('endSession remains bound to its target when the app re-enters before end() resolves', async ({ page, xr }) => {
  await xr.enterVR();
  const [{ sessionId }] = await xr.waitForSessionEvent('granted');
  await page.evaluate(() => {
    const end = window.session.end.bind(window.session);
    window.session.end = async () => {
      await end();
      window.session = await navigator.xr.requestSession('immersive-vr');
    };
  });
  expect(await xr.endSession({ sessionId })).toEqual({ sessionId });
  const second = await xr.waitForFrames(0);
  expect(second.sessionId).not.toBe(sessionId);
  expect(await xr.sessionMode()).toBe('immersive-vr');
  expect((await xr.sessionLog()).filter(entry => entry.event === 'end-called').map(entry => entry.sessionId)).toEqual([sessionId]);
  await xr.endSession({ sessionId: second.sessionId });
});

for (const behavior of ['throw', 'reject', 'resolve-without-event', 'hang']) {
  test(`endSession explains ${behavior} and removes its listener`, async ({ page, xr }) => {
    await xr.enterVR();
    await page.evaluate(behavior => {
      const session = window.session;
      window.restoreEnd = session.end.bind(session);
      window.endListeners = new Set();
      const add = session.addEventListener.bind(session);
      const remove = session.removeEventListener.bind(session);
      session.addEventListener = (type, callback, options) => {
        if (type === 'end') window.endListeners.add(callback);
        return add(type, callback, options);
      };
      session.removeEventListener = (type, callback, options) => {
        if (type === 'end') window.endListeners.delete(callback);
        return remove(type, callback, options);
      };
      session.end = () => {
        if (behavior === 'throw') throw new Error('injected end failure');
        if (behavior === 'reject') return Promise.reject(new Error('injected end failure'));
        if (behavior === 'resolve-without-event') return Promise.resolve();
        return new Promise(() => {});
      };
    }, behavior);
    await expect(xr.endSession({ timeout: 150 })).rejects.toThrow(
      /endSession: session-\d+: (end\(\) failed: injected end failure|timed out.*end event)/);
    expect(await page.evaluate(() => window.endListeners.size)).toBe(0);
    await page.evaluate(() => window.restoreEnd());
  });
}

test('waitForFrames observes successive XR frames with the changed pose', async ({ page, xr }) => {
  await xr.enterVR();
  const [{ sessionId }] = await xr.waitForSessionEvent('granted');
  await page.evaluate(async () => {
    const space = await window.session.requestReferenceSpace('local');
    window.observedFrames = [];
    const observe = (time, frame) => {
      window.observedFrames.push({ time, x: frame.getViewerPose(space).transform.position.x });
      window.session.requestAnimationFrame(observe);
    };
    window.session.requestAnimationFrame(observe);
  });
  await xr.setHeadPose({ position: [0.75, 1.6, 0] });
  const before = await page.evaluate(() => window.observedFrames.length);
  expect(await xr.waitForFrames(3, { sessionId })).toEqual({ sessionId, frames: 3 });
  const observed = await page.evaluate(before => window.observedFrames.slice(before), before);
  expect(new Set(observed.map(frame => frame.time)).size).toBeGreaterThanOrEqual(3);
  expect(observed.every(frame => Math.abs(frame.x - 0.75) < 0.0001)).toBe(true);
  expect(await xr.waitForFrames(0, { sessionId })).toEqual({ sessionId, frames: 0 });
});

test('DOM frames do not satisfy waitForFrames; timeouts cancel pending XR callbacks', async ({ page, xr }) => {
  await page.goto('https://xr.test/?noFrames');
  await xr.enterVR();
  await page.evaluate(() => {
    window.domFrames = 0;
    const tick = () => { window.domFrames++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    window.cancelled = [];
    const cancel = window.session.cancelAnimationFrame.bind(window.session);
    window.session.cancelAnimationFrame = id => { window.cancelled.push(id); cancel(id); };
  });
  await expect(xr.waitForFrames(2, { timeout: 200 })).rejects.toThrow(/timed out.*XR frames \(0\/2\)/);
  expect(await page.evaluate(() => window.domFrames)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.cancelled.length)).toBe(1);
  await xr.endSession();
  await xr.enterVR();
  // The page still omits its layer. Zero frames remains a valid bound no-op.
  expect((await xr.waitForFrames(0)).frames).toBe(0);
});

test('waitForFrames rejects on exit and does not consume a re-entered session', async ({ page, xr }) => {
  await xr.enterVR();
  const [{ sessionId }] = await xr.waitForSessionEvent('granted');
  // Arm the exit after the helper's first request, avoiding a timing race in the test.
  await page.evaluate(() => {
    const session = window.session;
    const request = session.requestAnimationFrame.bind(session);
    session.requestAnimationFrame = callback => {
      session.requestAnimationFrame = request;
      setTimeout(() => session.end(), 30);
      return request(callback);
    };
  });
  await expect(xr.waitForFrames(1000, { sessionId, timeout: 2_000 })).rejects.toThrow(/session ended after \d+\/1000 XR frames/);
  await xr.enterVR();
  const result = await xr.waitForFrames(2);
  expect(result.sessionId).not.toBe(sessionId);
});

test('a pending frame wait rejects when its document is replaced', async ({ page, xr }) => {
  await page.goto('https://xr.test/?noFrames');
  await xr.enterVR();
  const outcome = xr.waitForFrames(1).then(() => 'resolved', error => error.message);
  await page.reload();
  expect(await outcome).toMatch(/context was destroyed|navigation|no active session/i);
  await xr.enterVR();
  expect((await xr.waitForFrames(0)).frames).toBe(0);
});

test('session operations reject invalid options before requesting an exit or frame', async ({ xr }) => {
  await xr.enterVR();
  for (const count of [-1, 0.5, NaN, Infinity, '2', Number.MAX_SAFE_INTEGER + 1]) {
    await expect(xr.waitForFrames(count)).rejects.toThrow(/non-negative safe integer/);
  }
  for (const timeout of [0, -1, Infinity, NaN]) {
    await expect(xr.endSession({ timeout })).rejects.toThrow(/timeout/);
    await expect(xr.waitForFrames(2, { timeout })).rejects.toThrow(/timeout/);
  }
  for (const sessionId of [null, '', 123]) {
    await expect(xr.endSession({ sessionId })).rejects.toThrow(/sessionId/);
    await expect(xr.waitForFrames(2, { sessionId })).rejects.toThrow(/sessionId/);
  }
  expect(await xr.sessionMode()).toBe('immersive-vr');
  expect((await xr.sessionLog()).filter(entry => entry.event === 'end-called')).toEqual([]);
});

for (const hand of ['left', 'right']) {
  test(`aiming sample points the actual ${hand} target ray at tracking-space targets`, async ({ page, xr }) => {
    // With an identity head pose at creation, local space equals tracking space.
    await xr.setHeadPose({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
    await xr.enterVR();
    const position = [0.3, 1.3, -0.4];
    for (const offset of [[0, 0, -2], [0, 0, 2], [2, 0, 0], [0, 2, 0], [-1, -0.5, -2], [1e-7, 0, 2]]) {
      const target = offset.map((value, i) => value + position[i]);
      const quaternion = aimQuaternion(position, target);
      expect(Math.hypot(...quaternion)).toBeCloseTo(1, 12);
      await xr.setControllerPose(hand, { position, quaternion });
      await xr.waitForFrames(2);
      const ray = await page.evaluate(async hand => {
        const session = window.session;
        const space = await session.requestReferenceSpace('local');
        return new Promise(resolve => session.requestAnimationFrame((_time, frame) => {
          const input = Array.from(session.inputSources).find(input => input.handedness === hand);
          const m = frame.getPose(input.targetRaySpace, space).transform.matrix;
          resolve({ origin: [m[12], m[13], m[14]], direction: [-m[8], -m[9], -m[10]] });
        }));
      }, hand);
      for (let i = 0; i < 3; i++) {
        expect(ray.origin[i]).toBeCloseTo(position[i], 5);
        expect(ray.direction[i]).toBeCloseTo(offset[i] / Math.hypot(...offset), 5);
      }
    }
    await xr.pressButton(hand, 'trigger');
    await expect.poll(() => page.evaluate(() => window.inputEvents)).toContain(hand);
  });
}

test('aiming sample rejects coincident and non-finite points', () => {
  expect(() => aimQuaternion([1, 2, 3], [1, 2, 3])).toThrow(/non-zero finite direction/);
  expect(() => aimQuaternion([0, 0], [0, 0, -1])).toThrow(/three finite coordinates/);
  expect(() => aimQuaternion([0, 0, 0], [Infinity, 0, -1])).toThrow(/three finite coordinates/);
});
