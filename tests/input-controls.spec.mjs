import fs from 'node:fs/promises';
import { test, expect } from '../src/index.mjs';
import { composePose, invertPose } from '../src/pose.mjs';

const world = await fs.readFile(new URL('./fixtures/world.html', import.meta.url), 'utf8');

test.beforeEach(async ({ page, xr }) => {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: world }));
  await page.goto('https://xr.test/');
  await xr.enterVR();
  await xr.waitForFrames(1);
});

// App-side recorder: what the app could observe in each XR frame.
async function record(page, { busyMs = 0 } = {}) {
  await page.evaluate(async busyMs => {
    const session = window.session;
    const space = await session.requestReferenceSpace('local');
    window.rec = { frames: [], events: [] };
    for (const type of ['select', 'selectstart', 'selectend', 'squeezestart', 'squeezeend']) {
      session.addEventListener(type, e => rec.events.push({ type, hand: e.inputSource.handedness, frame: rec.frames.length }));
    }
    session.addEventListener('inputsourceschange', e => rec.events.push({
      type: 'inputsourceschange', frame: rec.frames.length,
      added: e.added.map(s => s.handedness), removed: e.removed.map(s => s.handedness),
    }));
    const tick = (_t, frame) => {
      const start = performance.now();
      while (performance.now() - start < busyMs) { /* simulate a loaded page */ }
      const entry = { t: performance.now(), hands: {} };
      for (const source of session.inputSources) {
        const gp = source.gamepad;
        const ray = frame.getPose(source.targetRaySpace, space);
        const grip = source.gripSpace && frame.getPose(source.gripSpace, space);
        const pose = p => p && {
          position: [p.transform.position.x, p.transform.position.y, p.transform.position.z],
          quaternion: [p.transform.orientation.x, p.transform.orientation.y, p.transform.orientation.z, p.transform.orientation.w],
        };
        entry.hands[source.handedness] = {
          trigger: gp.buttons[0].value, squeeze: gp.buttons[1].value, axes: [gp.axes[2], gp.axes[3]],
          ray: pose(ray), grip: pose(grip),
        };
      }
      rec.frames.push(entry);
      session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  }, busyMs);
}

const frames = page => page.evaluate(() => rec.frames);
const events = page => page.evaluate(() => rec.events);

test('pressButton survives a slow page where an unsynchronised press is lost', async ({ page, xr }) => {
  await record(page, { busyMs: 150 });
  // Control: the previous approach. Both values land before IWER's next frame,
  // so the pending press is overwritten and the app never sees it.
  await page.evaluate(() => {
    const c = globalThis.__xrDevice.controllers.right;
    c.updateButtonValue('trigger', 1);
    c.updateButtonValue('trigger', 0);
  });
  await xr.waitForFrames(3);
  expect((await events(page)).filter(e => e.type === 'select')).toHaveLength(0);

  const result = await xr.pressButton('right', 'trigger', { holdMs: 0 });
  expect(result.frames).toBeGreaterThanOrEqual(3);
  const pressed = (await frames(page)).filter(f => f.hands.right?.trigger === 1);
  expect(pressed.length).toBeGreaterThanOrEqual(2);
  expect((await events(page)).filter(e => e.type === 'select' && e.hand === 'right')).toHaveLength(1);
  expect((await frames(page)).at(-1).hands.right.trigger).toBe(0);
});

test('hold keeps a button down across later calls until release', async ({ page, xr }) => {
  await record(page);
  await xr.hold('left', 'squeeze');
  await xr.setControllerPose('left', { position: [-0.1, 1.4, -0.5] });
  await xr.waitForFrames(3);
  let seen = await events(page);
  expect(seen.filter(e => e.type === 'squeezestart')).toHaveLength(1);
  expect(seen.filter(e => e.type === 'squeezeend')).toHaveLength(0);
  expect((await frames(page)).at(-1).hands.left.squeeze).toBe(1);
  await xr.release('left', 'squeeze');
  seen = await events(page);
  expect(seen.filter(e => e.type === 'squeezeend')).toHaveLength(1);
});

test('unknown buttons and hands fail instead of warning', async ({ xr }) => {
  await expect(xr.pressButton('right', 'triger')).rejects.toThrow(/no button 'triger'.*trigger/);
  await expect(xr.hold('middle', 'squeeze')).rejects.toThrow(/hand must be/);
});

test('drag hovers, grabs, moves through intermediate frames and releases at the end', async ({ page, xr }) => {
  await record(page, { busyMs: 40 });
  const from = [0.2, 1.3, -0.4];
  const to = [0.4, 1.3, -0.4];
  await xr.drag('right', { from, to, ms: 200, steps: 6 });
  const all = await frames(page);
  const seen = await events(page);
  const start = seen.find(e => e.type === 'squeezestart').frame;
  const end = seen.find(e => e.type === 'squeezeend').frame;
  // Events dispatch at frame start, so frame `start` is the first held frame
  // and frame `end` the first released one. The app saw the start pose before
  // the grab and the end pose while still held.
  const x = i => all[i].hands.right.ray.position[0];
  const x0 = x(start - 1);
  expect(all[start - 1].hands.right.squeeze).toBe(0);
  const held = all.slice(start - 1, end).map((_, i) => x(start - 1 + i));
  expect(held[held.length - 1] - x0).toBeCloseTo(0.2, 4);
  const intermediate = held.filter(v => v - x0 > 0.001 && v - x0 < 0.199);
  expect(intermediate.length).toBeGreaterThanOrEqual(4);
  for (let i = 1; i < held.length; i++) expect(held[i]).toBeGreaterThanOrEqual(held[i - 1] - 1e-9);
  expect(all[end - 1].hands.right.squeeze).toBe(1);
  expect(all[end].hands.right.squeeze).toBe(0);
});

test('setGripPose places the profile grip point, verified through the app gripSpace', async ({ page, xr }) => {
  await record(page);
  const target = [0.1, 1.2, -0.3];
  const rayPose = await xr.setGripPose('right', { position: target });
  await xr.waitForFrames(2);
  const last = (await frames(page)).at(-1).hands.right;
  // tracking -> local: the transform that maps the tracking ray pose onto the app's ray pose.
  const trackingToLocal = composePose(last.ray, invertPose(rayPose));
  const gripTracking = composePose(invertPose(trackingToLocal), last.grip);
  gripTracking.position.forEach((c, i) => expect(c).toBeCloseTo(target[i], 5));
  // The raw controller position differs from the grip by the profile offset (~5 cm).
  const lever = Math.hypot(...rayPose.position.map((c, i) => c - target[i]));
  expect(lever).toBeGreaterThan(0.04);
  expect(lever).toBeLessThan(0.06);
  const pose = await xr.controllerPose('right');
  pose.grip.position.forEach((c, i) => expect(c).toBeCloseTo(target[i], 6));

  // With an orientation, the grip itself takes that orientation.
  const q = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
  await xr.setGripPose('left', { position: [-0.1, 1.2, -0.3], quaternion: q });
  const left = await xr.controllerPose('left');
  left.grip.quaternion.forEach((c, i) => expect(Math.abs(c)).toBeCloseTo(Math.abs(q[i]), 6));
});

test('drag in grip space moves the grip point along the requested path', async ({ page, xr }) => {
  await record(page);
  await xr.drag('right', { from: [0.1, 1.2, -0.3], to: [0.1, 1.4, -0.3], ms: 100, space: 'grip' });
  const pose = await xr.controllerPose('right');
  pose.grip.position.forEach((c, i) => expect(c).toBeCloseTo([0.1, 1.4, -0.3][i], 6));
});

test('flick tilts for a few frames then centres; holdAxes honours a minimum duration', async ({ page, xr }) => {
  await record(page);
  await xr.flick('right', 'right');
  let all = await frames(page);
  let tilted = all.filter(f => f.hands.right.axes[0] === 1);
  expect(tilted.length).toBeGreaterThanOrEqual(2);
  expect(all.at(-1).hands.right.axes).toEqual([0, 0]);

  await page.evaluate(() => { rec.frames = []; });
  await xr.flick('left', 'up');
  all = await frames(page);
  expect(all.some(f => f.hands.left.axes[1] === -1)).toBe(true);

  await page.evaluate(() => { rec.frames = []; });
  await xr.holdAxes('right', 0, 0.5, { ms: 250 });
  all = await frames(page);
  tilted = all.filter(f => f.hands.right.axes[1] === 0.5);
  expect(tilted.at(-1).t - tilted[0].t).toBeGreaterThanOrEqual(200);
  expect(all.at(-1).hands.right.axes).toEqual([0, 0]);
});

test('disconnect and reconnect change the session input sources', async ({ page, xr }) => {
  await record(page);
  await xr.disconnect('right');
  expect(await page.evaluate(() => Array.from(window.session.inputSources, s => s.handedness))).toEqual(['left']);
  await xr.reconnect('right');
  expect((await page.evaluate(() => Array.from(window.session.inputSources, s => s.handedness))).sort()).toEqual(['left', 'right']);
  const changes = (await events(page)).filter(e => e.type === 'inputsourceschange');
  expect(changes.map(c => [c.added, c.removed])).toEqual([[[], ['right']], [['right'], []]]);
  expect((await xr.controllerPose('right')).connected).toBe(true);
});

test('haptics records pulses from both actuator access paths', async ({ page, xr }) => {
  await page.evaluate(() => {
    const [left, right] = ['left', 'right'].map(h => Array.from(window.session.inputSources).find(s => s.handedness === h));
    right.gamepad.hapticActuators[0].pulse(0.5, 30);
    left.gamepad.vibrationActuator?.pulse(1, 10);
  });
  const right = await xr.haptics('right');
  expect(right).toHaveLength(1);
  expect(right[0]).toMatchObject({ hand: 'right', actuator: 0, value: 0.5, duration: 30 });
  expect((await xr.haptics()).length).toBeGreaterThanOrEqual(1);
});

test('projectPoint maps view-relative points to NDC, pixels and degrees', async ({ xr }) => {
  await xr.setHeadPose({ position: [0, 1.6, 0], quaternion: [0, 0, 0, 1] });
  await xr.waitForFrames(1);
  const ahead = await xr.projectPoint([0, 1.6, -2]);
  expect(ahead.inView).toBe(true);
  ahead.ndc.slice(0, 2).forEach(c => expect(c).toBeCloseTo(0, 6));
  expect(ahead.pixel[0]).toBeCloseTo(ahead.viewport.width / 2, 3);
  expect(ahead.degreesFromCenter).toBeCloseTo(0, 6);
  // 960x540 mono with IWER's 90° vertical fov: 270 px per tan unit -> ~4.71 px/deg.
  expect(ahead.pixelsPerDegree).toBeCloseTo(270 * Math.PI / 180, 3);

  const up = await xr.projectPoint([0, 1.6 + 2 * Math.tan(Math.PI / 9), -2]);
  expect(up.degreesFromCenter).toBeCloseTo(20, 4);
  expect(up.ndc[1]).toBeGreaterThan(0);
  expect(up.pixel[1]).toBeLessThan(ahead.pixel[1]);

  const behind = await xr.projectPoint([0, 1.6, 2]);
  expect(behind.inView).toBe(false);
  expect(behind.behind).toBe(true);

  // A yawed head moves the projection: the point now lies 30° to the right.
  await xr.setHeadPose({ euler: [0, Math.PI / 6, 0] });
  await xr.waitForFrames(1);
  const turned = await xr.projectPoint([0, 1.6, -2]);
  expect(turned.degreesFromCenter).toBeCloseTo(30, 4);
  expect(turned.ndc[0]).toBeGreaterThan(0);
});

// An app that moves a held object to the hand pose of the PREVIOUS frame.
async function laggedFollower(page) {
  await page.evaluate(async () => {
    const session = window.session;
    const space = await session.requestReferenceSpace('local');
    window.follow = { x: null, grabbedAt: null };
    let held = false;
    let previous = null;
    const tick = (_t, frame) => {
      const source = Array.from(session.inputSources).find(s => s.handedness === 'left');
      const x = source && frame.getPose(source.gripSpace, space).transform.position.x;
      const squeezed = source?.gamepad.buttons[1].value === 1;
      if (squeezed && !held) { follow.grabbedAt = x; follow.x = x; }
      else if (squeezed && previous !== null) follow.x = previous;
      held = squeezed;
      previous = x;
      session.requestAnimationFrame(tick);
    };
    session.requestAnimationFrame(tick);
  });
}

test('drag holds the end pose long enough for an app that follows one frame late', async ({ page, xr }) => {
  await laggedFollower(page);
  const path = { from: [-0.3, 1.2, -0.3], to: [0, 1.2, -0.3], ms: 0, steps: 5, space: 'grip' };
  // Control: releasing one frame after the end pose loses the last segment.
  await xr.drag('left', { ...path, settleFrames: 1 });
  let moved = await page.evaluate(() => follow.x - follow.grabbedAt);
  expect(moved).toBeLessThan(0.299);
  await xr.drag('left', path);
  moved = await page.evaluate(() => follow.x - follow.grabbedAt);
  expect(moved).toBeCloseTo(0.3, 5);
});

test('holdAxes with release: false leaves the stick tilted', async ({ page, xr }) => {
  await record(page);
  await xr.holdAxes('right', 0.7, 0, { release: false });
  await xr.waitForFrames(2);
  expect((await frames(page)).at(-1).hands.right.axes).toEqual([expect.closeTo(0.7, 6), 0]);
  await xr.holdAxes('right', 0, 0, { frames: 1, release: false });
  expect((await frames(page)).at(-1).hands.right.axes).toEqual([0, 0]);
});

test('haptics cursor separates pulses before and after an action', async ({ page, xr }) => {
  const pulse = () => page.evaluate(() => Array.from(window.session.inputSources)
    .find(s => s.handedness === 'right').gamepad.hapticActuators[0].pulse(0.2, 20));
  await pulse();
  const cursor = await xr.hapticsCursor();
  expect(cursor).toBe(1);
  await pulse();
  await pulse();
  const newer = await xr.haptics('right', { after: cursor });
  expect(newer.map(e => e.sequence)).toEqual([2, 3]);
  expect((await xr.haptics({ after: 2 })).map(e => e.sequence)).toEqual([3]);
  await expect(xr.haptics({ after: -1 })).rejects.toThrow(/cursor/);
});

test('sequence runs a timed two-hand script alongside in-page recording', async ({ page, xr }) => {
  await record(page);
  await xr.sequence([
    { button: ['left', 'squeeze', 1] }, { frames: 2 },
    { button: ['left', 'squeeze', 0] }, { frames: 1 },
    { wait: 60 },
    { axes: ['right', 0, -1] }, { frames: 2 },
    { axes: ['right', 0, 0] }, { frames: 1 },
  ]);
  const all = await frames(page);
  const released = (await events(page)).find(e => e.type === 'squeezeend').frame;
  const tilted = all.findIndex(f => f.hands.right.axes[1] === -1);
  expect(tilted).toBeGreaterThan(released);
  expect(all[tilted].t - all[released].t).toBeGreaterThanOrEqual(55);
  expect(all.at(-1).hands.right.axes).toEqual([0, 0]);

  await expect(xr.sequence([{ button: ['left', 'squeeze', 1], frames: 1 }])).rejects.toThrow(/exactly one/);
  await expect(xr.sequence([{ button: ['left', 'grip', 1] }])).rejects.toThrow(/no button 'grip'/);
  await expect(xr.sequence([])).rejects.toThrow(/non-empty/);
});
