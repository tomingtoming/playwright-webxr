import fs from 'node:fs/promises';
import { test, expect } from '../src/index.mjs';
import { composePose, invertPose, rotateVector, transformPoint } from '../src/pose.mjs';

const inspect = await fs.readFile(new URL('./fixtures/inspect.html', import.meta.url), 'utf8');
const world = await fs.readFile(new URL('./fixtures/world.html', import.meta.url), 'utf8');

async function open(page, xr, body = inspect) {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body }));
  await page.goto('https://xr.test/');
  await xr.enterVR();
  await xr.waitForFrames(2);
}

// Where the sidecar's own numbers say a tracking-space point must appear.
function pixelFromMetadata(capture, point, eye) {
  const view = capture.view.views.find(v => v.eye === eye);
  const eyePose = composePose(capture.view.head, view.fromHead);
  const inverse = invertPose(eyePose);
  const local = rotateVector(inverse.quaternion, point).map((c, i) => c + inverse.position[i]);
  const [x, y, , w] = transformPoint(view.projectionMatrix, local);
  const { viewport: vp } = view;
  return [vp.x + (x / w + 1) / 2 * vp.width, capture.height - (vp.y + (y / w + 1) / 2 * vp.height)];
}

// Where the green marker really is in the PNG, read back from the file.
async function greenCentroid(page, file, region) {
  const base64 = (await fs.readFile(file)).toString('base64');
  return page.evaluate(async ({ base64, region }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const c = canvas.getContext('2d', { willReadFrequently: true });
    c.drawImage(image, 0, 0);
    const { x: rx = 0, width: rw = image.width } = region ?? {};
    const { data } = c.getImageData(rx, 0, rw, image.height);
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < image.height; y++) for (let x = 0; x < rw; x++) {
      const i = (y * rw + x) * 4;
      if (data[i] < 40 && data[i + 1] > 220 && data[i + 2] < 40) { sx += rx + x + 0.5; sy += y + 0.5; n++; }
    }
    return n ? [sx / n, sy / n, n] : null;
  }, { base64, region });
}

test('metadata explains the framing of two head poses, down to the pixels', async ({ page, xr }, testInfo) => {
  await open(page, xr);
  const marker = await page.evaluate(() => window.scene.marker);
  const poses = {
    front: { position: [0, 1.4, 0], quaternion: [0, 0, 0, 1] },
    turned: { position: [-0.3, 1.5, -0.2], euler: [0, 0.2, 0.1] },
  };
  const seen = {};
  for (const [name, pose] of Object.entries(poses)) {
    await xr.setHeadPose(pose);
    await xr.waitForFrames(2);
    const capture = await xr.attachCapture(testInfo, name, { canvas: '#world' });
    const predicted = pixelFromMetadata(capture, marker, 'left');
    const actual = await greenCentroid(page, capture.path);
    expect(actual, `${name}: the marker must be in the image`).not.toBeNull();
    expect(Math.abs(actual[0] - predicted[0])).toBeLessThan(1.5);
    expect(Math.abs(actual[1] - predicted[1])).toBeLessThan(1.5);
    seen[name] = { capture, actual };
  }
  // The images differ, and so do the poses that explain them.
  expect(Math.abs(seen.front.actual[0] - seen.turned.actual[0])).toBeGreaterThan(20);
  for (const name of Object.keys(poses)) {
    seen[name].capture.view.head.position.forEach((c, i) => expect(c).toBeCloseTo(poses[name].position[i], 5));
  }

  // Report attachments and the sidecar on disk.
  expect(testInfo.attachments.map(a => a.name)).toEqual(['front.png', 'front.json', 'turned.png', 'turned.json']);
  const sidecar = JSON.parse(await fs.readFile(testInfo.outputPath('front.json'), 'utf8'));
  expect(sidecar.view.coordinateSpace).toBe('iwer-tracking');
  expect(sidecar.view.sampling).toBe('same-xr-frame');
  expect(sidecar.view.projection).toBe('emulator');
  expect(sidecar.view.frame.time).toBeGreaterThan(0);
  await expect(xr.attachCapture(testInfo, '../escape')).rejects.toThrow(/name may contain/);
});

test('metadata reports both controllers, the grip and the mono eye layout', async ({ page, xr }, testInfo) => {
  await open(page, xr);
  await xr.setGripPose('right', { position: [0.2, 1.2, -0.4] });
  await xr.waitForFrames(2);
  const { view, reference } = await xr.screenshot(testInfo.outputPath('hands.png'), { canvas: '#world', metadata: true });
  expect(reference).toBeUndefined();
  view.controllers.right.grip.position.forEach((c, i) => expect(c).toBeCloseTo([0.2, 1.2, -0.4][i], 5));
  const pose = await xr.controllerPose('left');
  expect(view.controllers.left.targetRay.position).toEqual(pose.targetRay.position);
  expect(view.controllers.left.connected).toBe(true);
  expect(view.stereoEnabled).toBe(false);
  expect(view.ipd).toBe(0);
  const left = view.views.find(v => v.eye === 'left');
  expect(left.frustum.up).toBeCloseTo(45, 3);
  expect(left.frustum.down).toBeCloseTo(-45, 3);
  expect(left.viewport.width).toBeGreaterThan(0);
});

test('a physical device is reported as a reference, separate from the projection used', async ({ page, xr }, testInfo) => {
  await open(page, xr);
  const capture = await xr.screenshot(testInfo.outputPath('r.png'), { canvas: '#world', metadata: true, device: 'quest3s' });
  expect(capture.reference).toMatchObject({ kind: 'device-reference', device: 'quest3s', fov: { outer: 49, inner: 45, up: 48, down: 50 } });
  expect(capture.view.projection).toBe('emulator');
  expect(capture.view.views.find(v => v.eye === 'left').frustum.up).toBeCloseTo(45, 3);
  await expect(xr.screenshot(testInfo.outputPath('x.png'), { device: 'quest3s' })).rejects.toThrow(/needs metadata/);
  await expect(xr.screenshot(testInfo.outputPath('x.png'), { metadata: true, device: 'quest9' })).rejects.toThrow(/unknown device/);
});

test('missing views are explained instead of guessed', async ({ page, xr }, testInfo) => {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: world }));
  await page.goto('https://xr.test/?noFrames');
  const before = await xr.screenshot(testInfo.outputPath('a.png'), { canvas: '#world', metadata: true });
  expect(before).toMatchObject({ view: null, viewReason: 'No active session', sessionId: null });
  await xr.enterVR();
  // Disable XR frames so the sampled view cannot arrive.
  await page.evaluate(() => { window.session.requestAnimationFrame = () => 0; });
  const stalled = await xr.screenshot(testInfo.outputPath('b.png'), { canvas: '#world', metadata: true, timeout: 400 });
  expect(stalled.view).toBeNull();
  expect(stalled.viewReason).toMatch(/No XR frame within 200ms/);
  expect(stalled.sessionId).toMatch(/^session-/);
});

test.describe('stereo', () => {
  test.use({ xrStereoEnabled: true, viewport: { width: 1280, height: 480 } });
  test('metadata gives each eye its own viewport and offset, matching the image', async ({ page, xr }, testInfo) => {
    await open(page, xr);
    const marker = await page.evaluate(() => window.scene.marker);
    await xr.setHeadPose({ position: [0, 1.4, 0], quaternion: [0, 0, 0, 1] });
    await xr.waitForFrames(2);
    const capture = await xr.attachCapture(testInfo, 'stereo', { canvas: '#world' });
    expect(capture.view.stereoEnabled).toBe(true);
    expect(capture.view.ipd).toBeCloseTo(0.064, 6);
    for (const eye of ['left', 'right']) {
      const view = capture.view.views.find(v => v.eye === eye);
      expect(view.viewport.width).toBe(640);
      const [x, y] = pixelFromMetadata(capture, marker, eye);
      const found = await greenCentroid(page, capture.path, { x: view.viewport.x, width: view.viewport.width });
      expect(found, `${eye} eye`).not.toBeNull();
      expect(Math.abs(found[0] - x)).toBeLessThan(1.5);
      expect(Math.abs(found[1] - y)).toBeLessThan(1.5);
    }
  });
});
