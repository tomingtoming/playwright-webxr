import fs from 'node:fs/promises';
import { test, expect } from '../src/index.mjs';
import { captureViews, lookAtHeadPose } from 'playwright-webxr/examples/inspect-views';
import { rotateVector } from '../src/pose.mjs';

const inspect = await fs.readFile(new URL('./fixtures/inspect.html', import.meta.url), 'utf8');

const close = (actual, expected, digits = 5) => actual.forEach((c, i) => expect(c).toBeCloseTo(expected[i], digits));

test.describe('lookAtHeadPose', () => {
  test('looks along -Z at the target and stays upright', () => {
    const target = [1, 2, 3];
    const { position, quaternion } = lookAtHeadPose({ target, distance: 2, yaw: 0.5, pitch: 0.3 });
    expect(Math.hypot(...position.map((c, i) => c - target[i]))).toBeCloseTo(2, 6);
    const forward = rotateVector(quaternion, [0, 0, -1]);
    close(forward, target.map((c, i) => (c - position[i]) / 2));
    // Upright: the head's right vector stays level.
    expect(rotateVector(quaternion, [1, 0, 0])[1]).toBeCloseTo(0, 6);
    expect(rotateVector(quaternion, [0, 1, 0])[1]).toBeGreaterThan(0);
  });

  test('documented signs of yaw, pitch and roll', () => {
    const target = [0, 0, 0];
    close(lookAtHeadPose({ target, distance: 1 }).position, [0, 0, 1]);
    expect(lookAtHeadPose({ target, distance: 1, yaw: 0.4 }).position[0]).toBeGreaterThan(0);
    expect(lookAtHeadPose({ target, distance: 1, pitch: 0.4 }).position[1]).toBeGreaterThan(0);
    const rolled = lookAtHeadPose({ target, distance: 1, roll: Math.PI / 2 }).quaternion;
    close(rotateVector(rolled, [0, 1, 0]), [-1, 0, 0]);
  });

  test('an explicit up direction is honoured', () => {
    const { position, quaternion } = lookAtHeadPose({ target: [0, 0, 0], distance: 1, up: [0, 0, 1], front: [0, -1, 0] });
    close(position, [0, -1, 0]);
    close(rotateVector(quaternion, [0, 1, 0]), [0, 0, 1]);
  });

  test('impossible poses fail', () => {
    expect(() => lookAtHeadPose({ target: [0, 0, 0], distance: 0 })).toThrow(/distance/);
    expect(() => lookAtHeadPose({ target: [0, 0], distance: 1 })).toThrow(/target/);
    expect(() => lookAtHeadPose({ target: [0, 0, 0], distance: 1, pitch: Math.PI / 2 })).toThrow(/parallel to up/);
    expect(() => lookAtHeadPose({ target: [0, 0, 0], distance: 1, front: [0, 1, 0] })).toThrow(/parallel to up/);
  });
});

async function open(page, xr) {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: inspect }));
  await page.goto('https://xr.test/');
  await xr.enterVR();
  await xr.waitForFrames(2);
  return page.evaluate(() => window.scene);
}

// Counts pixels by the fixture's flat colours.
async function colours(page, file) {
  const base64 = (await fs.readFile(file)).toString('base64');
  return page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(image, 0, 0);
    const { data } = c.getImageData(0, 0, image.width, image.height);
    const count = { leftWall: 0, rightWall: 0, backWall: 0, panel: 0, marker: 0, markerX: 0 };
    const is = (i, r, g, b) => Math.abs(data[i] - r) < 20 && Math.abs(data[i + 1] - g) < 20 && Math.abs(data[i + 2] - b) < 20;
    for (let i = 0; i < data.length; i += 4) {
      if (is(i, 204, 77, 77)) count.leftWall++;
      else if (is(i, 204, 204, 77)) count.rightWall++;
      else if (is(i, 77, 77, 204)) count.backWall++;
      else if (is(i, 230, 230, 230)) count.panel++;
      else if (is(i, 0, 255, 0)) { count.marker++; count.markerX += (i / 4) % image.width + 0.5; }
    }
    count.markerX /= count.marker || 1;
    return count;
  }, base64);
}

test('five named views frame their targets, are attached, and the head pose is restored', async ({ page, xr }, testInfo) => {
  const { cutaway, panel, marker } = await open(page, xr);
  const start = { position: [0.1, 1.6, 0.2], quaternion: [0, 0, 0, 1] };
  await xr.setHeadPose(start);
  await xr.waitForFrames(2);

  const oblique = 35 * Math.PI / 180;
  const views = [
    { name: 'front', target: cutaway, distance: 1.2 },
    { name: 'left-oblique', target: cutaway, distance: 1.2, yaw: -oblique },
    { name: 'right-oblique', target: cutaway, distance: 1.2, yaw: oblique },
    { name: 'close-up', target: marker, distance: 0.45 },
    { name: 'full-panel', target: panel, distance: 1.1 },
  ];
  const readied = [];
  const centred = {};
  const shots = await captureViews(xr, testInfo, views, {
    canvas: '#world',
    ready: async ({ name }) => {
      readied.push(name);
      expect(await page.evaluate(() => window.framesRendered)).toBeGreaterThan(0);
      const view = views.find(v => v.name === name);
      centred[name] = await xr.projectPoint(view.target);
      if (name === 'full-panel') {
        for (const x of [-0.2, 0.2]) for (const y of [-0.3, 0.3]) {
          const corner = await xr.projectPoint([panel[0] + x, panel[1] + y, panel[2]]);
          expect(corner.inView, `panel corner ${x},${y}`).toBe(true);
        }
      }
    },
  });

  expect(readied).toEqual(views.map(v => v.name));
  for (const name of readied) {
    centred[name].ndc.slice(0, 2).forEach(c => expect(Math.abs(c)).toBeLessThan(1e-4));
    expect(centred[name].inView).toBe(true);
  }
  expect(testInfo.attachments.map(a => a.name)).toEqual(readied.flatMap(n => [`${n}.png`, `${n}.json`]));

  // The camera is where the sidecar says, restored afterwards.
  close(shots['left-oblique'].capture.view.head.position, shots['left-oblique'].pose.position);
  const after = await xr.headPose();
  close(after.position, start.position);
  close(after.quaternion, start.quaternion);

  // Oblique views reveal more of the inner walls than the frontal view.
  const count = {};
  for (const name of readied) count[name] = await colours(page, shots[name].capture.path);
  expect(count['left-oblique'].rightWall).toBeGreaterThan(count.front.rightWall * 2);
  expect(count['right-oblique'].leftWall).toBeGreaterThan(count.front.leftWall * 2);
  // The marker sits behind the target, so it shifts towards the camera's own side:
  // this is what separates the two oblique views.
  const centre = shots.front.capture.width / 2;
  expect(count['left-oblique'].markerX).toBeLessThan(centre - 5);
  expect(count['right-oblique'].markerX).toBeGreaterThan(centre + 5);
  expect(count['close-up'].marker).toBeGreaterThan(count.front.marker * 2);
  expect(count['full-panel'].panel).toBeGreaterThan(count.front.panel);
});

test('the application supplies a world-to-tracking transform', async ({ page, xr }, testInfo) => {
  const { cutaway } = await open(page, xr);
  // A rig: the app's scene is the tracking scene shifted and turned 90 degrees about Y.
  const s = Math.SQRT1_2;
  const worldToTracking = { position: cutaway, quaternion: [0, s, 0, s] };
  let centred;
  const shots = await captureViews(xr, testInfo, [{ name: 'rig', target: [0, 0, 0], distance: 1 }], {
    canvas: '#world',
    worldToTracking,
    ready: async () => { centred = await xr.projectPoint(cutaway); },
  });
  centred.ndc.slice(0, 2).forEach(c => expect(Math.abs(c)).toBeLessThan(1e-4));
  // Scene front (+Z) maps to tracking +X, so the camera sits on the box's +X side.
  close(shots.rig.pose.position, [cutaway[0] + 1, cutaway[1], cutaway[2]]);
});

test('the starting pose is restored when a view fails, and bad views fail first', async ({ page, xr }, testInfo) => {
  const { cutaway } = await open(page, xr);
  const start = { position: [0, 1.5, 0.3], quaternion: [0, 0, 0, 1] };
  await xr.setHeadPose(start);
  await xr.waitForFrames(2);
  await expect(captureViews(xr, testInfo, [{ name: 'front', target: cutaway, distance: 1 }], {
    ready: async () => { throw new Error('app not ready'); },
  })).rejects.toThrow('app not ready');
  close((await xr.headPose()).position, start.position);

  await expect(captureViews(xr, testInfo, [
    { name: 'ok', target: cutaway, distance: 1 }, { name: 'bad', target: cutaway, distance: -1 },
  ])).rejects.toThrow(/distance/);
  await expect(captureViews(xr, testInfo, [
    { name: 'same', target: cutaway, distance: 1 }, { name: 'same', target: cutaway, distance: 2 },
  ])).rejects.toThrow(/unique/);
  expect(testInfo.attachments).toHaveLength(0);
});
