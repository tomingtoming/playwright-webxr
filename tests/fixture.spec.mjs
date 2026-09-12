import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test, expect } from '../src/index.mjs';

const world = await fs.readFile(new URL('./fixtures/world.html', import.meta.url), 'utf8');
const require = createRequire(import.meta.url);

test.beforeEach(async ({ page, xr }) => {
  await page.route('https://xr.test/**', route => route.fulfill({ contentType: 'text/html', body: world }));
  await page.goto('https://xr.test/');
  expect(await xr.runtimeInstalled()).toBe(true);
});

test('entry, exit, re-entry and scoped events track the current session', async ({ page, xr }) => {
  expect(await xr.sessionMode()).toBeNull();
  expect(await xr.sessionCursor()).toBe(0);
  await xr.enterVR();
  expect(await xr.sessionMode()).toBe('immersive-vr');
  expect(await page.evaluate(() => 'mode' in window.session)).toBe(false);
  const [first] = await xr.waitForSessionEvent('granted', 1_000);
  const after = await xr.sessionCursor();
  await page.evaluate(() => {
    window.__xrEndProbe = () => 'before-app-cleanup';
    window.session.addEventListener('end', () => { window.__xrEndProbe = () => 'after'; });
    return window.session.end();
  });
  const [ended] = await xr.waitForSessionEvent('end', { after, sessionId: first.sessionId });
  expect(ended.detail).toBe('before-app-cleanup');
  expect(await xr.sessionMode()).toBeNull();
  expect((await xr.diagnostics()).session).toBeNull();

  const cursor = await xr.sessionCursor();
  await expect(xr.waitForSessionEvent('granted', { after: cursor, timeout: 150 })).rejects.toThrow(/Timeout/);
  await xr.enterVR();
  const [second] = await xr.waitForSessionEvent('granted', { after: cursor });
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(second.requestId).not.toBe(first.requestId);
  expect(await xr.sessionMode()).toBe('immersive-vr');
  await expect(xr.waitForSessionEvent('end', { sessionId: second.sessionId, timeout: 150 })).rejects.toThrow(/Timeout/);
  await page.evaluate(() => window.session.end());
  await xr.waitForSessionEvent('end', { sessionId: second.sessionId });
  expect(await xr.sessionMode()).toBeNull();
  const events = await xr.sessionLog();
  expect(events.map(event => event.sequence)).toEqual(events.map((_, i) => i + 1));
  expect(events.filter(event => event.event === 'end-called')).toHaveLength(2);
});

test('a rejected request has no active session, including after an earlier grant', async ({ page, xr }) => {
  await xr.enterVR();
  await page.evaluate(() => window.session.end());
  const after = await xr.sessionCursor();
  await page.evaluate(() => {
    document.querySelector('#VRButton').onclick = () => navigator.xr.requestSession('immersive-vr', {
      requiredFeatures: ['deliberately-unsupported-feature'],
    }).catch(() => {});
  });
  await expect(xr.enterVR()).rejects.toThrow(/session request .* rejected: .*required features/i);
  const [rejected] = await xr.waitForSessionEvent('rejected', { after });
  expect(rejected.sessionId).toBeNull();
  expect(await xr.sessionMode()).toBeNull();
  await expect(xr.waitForSessionEvent('granted', { after, timeout: 150 })).rejects.toThrow(/Timeout/);
});

test('a rejected second request does not replace a live session', async ({ page, xr }) => {
  await xr.enterVR();
  const [granted] = await xr.waitForSessionEvent('granted');
  const after = await xr.sessionCursor();
  await page.evaluate(() => navigator.xr.requestSession('immersive-vr').catch(() => {}));
  await xr.waitForSessionEvent('rejected', { after });
  expect(await xr.sessionMode()).toBe('immersive-vr');
  expect((await xr.diagnostics({ canvas: '#world' })).session.id).toBe(granted.sessionId);
});

test('short-lived sessions remain in history, but enterVR reports they ended', async ({ page, xr }) => {
  await page.goto('https://xr.test/?endImmediately');
  await expect(xr.enterVR()).rejects.toThrow(/granted but is no longer active/);
  const [granted] = await xr.waitForSessionEvent('granted');
  await xr.waitForSessionEvent('end', { sessionId: granted.sessionId });
  expect(await xr.sessionMode()).toBeNull();
});

test('waits for a delayed button and clicks normally', async ({ page, xr }) => {
  await page.goto('https://xr.test/?delay=250');
  await xr.enterVR({ timeout: 2_000 });
  expect(await xr.sessionMode()).toBe('immersive-vr');
});

test('waits for hidden buttons to become visible', async ({ page, xr }) => {
  await page.goto('https://xr.test/?hidden');
  await page.waitForSelector('#VRButton', { state: 'attached' });
  await page.evaluate(() => setTimeout(() => { document.querySelector('#VRButton').style.display = ''; }, 250));
  await xr.enterVR({ timeout: 2_000 });
  expect(await xr.sessionMode()).toBe('immersive-vr');
});

test('a hidden first match does not hide the usable button', async ({ page, xr }) => {
  await page.waitForSelector('#VRButton');
  await page.evaluate(() => {
    const hidden = document.createElement('button');
    hidden.textContent = 'ENTER VR';
    hidden.hidden = true;
    document.body.prepend(hidden);
  });
  await xr.enterVR({ button: 'button:has-text("ENTER VR")' });
  expect(await xr.sessionMode()).toBe('immersive-vr');
});

test('covered buttons fail actionability; force is an explicit option', async ({ page, xr }) => {
  await page.goto('https://xr.test/?covered');
  await expect(xr.enterVR({ timeout: 350 })).rejects.toThrow(/VR button click failed/);
  expect(await xr.sessionLog()).toEqual([]);
  // force skips the check, but a real hit-tested click still hits the overlay.
  await expect(xr.enterVR({ force: true, timeout: 350 })).rejects.toThrow(/no new immersive-vr session/);
  expect(await xr.sessionMode()).toBeNull();
  await page.locator('#cover').evaluate(element => element.remove());
  await xr.enterVR({ force: true });
  expect(await xr.sessionMode()).toBe('immersive-vr');
});

for (const [query, reason] of [
  ['missing', /no VR button found/],
  ['hidden', /VR button found but not visible/],
  ['noRequest', /no new immersive-vr session/],
]) {
  test(`entry explains ${query}`, async ({ page, xr }) => {
    await page.goto(`https://xr.test/?${query}`);
    await expect(xr.enterVR({ timeout: 300 })).rejects.toThrow(reason);
    expect(await xr.sessionLog()).toEqual([]);
  });
}

test('navigation resets document-local history and installs the runtime again', async ({ page, xr }) => {
  await xr.enterVR();
  await page.reload();
  expect(await xr.sessionCursor()).toBe(0);
  expect(await xr.sessionMode()).toBeNull();
  await xr.enterVR();
  expect(await xr.sessionMode()).toBe('immersive-vr');
});

for (const stereo of [false, true]) {
  test.describe(stereo ? 'stereo' : 'mono', () => {
    test.use({ xrStereoEnabled: stereo, viewport: { width: stereo ? 2560 : 1280, height: 960 } });
    test('diagnoses actual eye viewports, layers, input and GPU', async ({ page, xr }, testInfo) => {
      await xr.enterVR();
      const diagnostics = await xr.diagnostics({ canvas: '#world' });
      await fs.writeFile(testInfo.outputPath('diagnostics.json'), JSON.stringify(diagnostics, null, 2));
      await testInfo.attach('diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
      expect(diagnostics.runtime).toMatchObject({
        installed: true, deviceProfile: 'metaQuest3', stereoEnabled: stereo, ipd: stereo ? 0.064 : 0,
      });
      expect(diagnostics.runtime.iwerVersion).toMatch(/^2\./);
      expect(diagnostics.runtime.browserVersion).toBe(page.context().browser().version());
      expect(diagnostics.runtime.originalUserAgent).not.toContain('Quest');
      expect(diagnostics.runtime.playwrightWebxrVersion).toBe(JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url))).version);
      expect(diagnostics.session.mode).toBe('immersive-vr');
      expect(diagnostics.session.enabledFeatures).toContain('viewer');
      expect(diagnostics.rendering.baseLayer.type).toBe('XRWebGLLayer');
      expect(diagnostics.rendering.canvas).toMatchObject({ width: stereo ? 2560 : 1280, height: 960, matchesBaseLayer: true });
      expect(diagnostics.rendering.viewsReason).toBeNull();
      expect(diagnostics.rendering.views).toEqual([
        { eye: 'left', viewport: { x: 0, y: 0, width: 1280, height: 960 }, viewportReason: null },
        { eye: 'right', viewport: { x: stereo ? 1280 : 640, y: 0, width: stereo ? 1280 : 0, height: 960 }, viewportReason: null },
      ]);
      // IWER without the layers polyfill does not expose renderState.layers.
      expect(diagnostics.rendering.layers).toBeNull();
      expect(diagnostics.rendering.projectionLayerCount).toBeNull();
      expect(diagnostics.rendering.layersReason).toContain('does not expose');
      expect(diagnostics.gpu.renderer).toBeTruthy();
      expect(diagnostics.inputSources.map(input => input.handedness).sort()).toEqual(['left', 'right']);
      await xr.pressButton('right', 'trigger');
      await expect.poll(() => page.evaluate(() => window.inputEvents)).toContain('right');
    });
  });
}

test.describe('explicit IPD', () => {
  test.use({ xrStereoEnabled: true, xrIpd: 0.07 });
  test('preserves the requested eye separation', async ({ xr }) => {
    expect((await xr.diagnostics()).runtime.ipd).toBe(0.07);
  });
});

test('diagnostics never creates a WebGL context on an unused canvas', async ({ page, xr }) => {
  const empty = await xr.diagnostics({ canvas: '#unused' });
  expect(empty.session).toBeNull();
  expect(empty.gpu.renderer).toBeNull();
  expect(empty.gpu.reason).toContain('No observed WebGL context');
  expect(empty.rendering.views).toBeNull();
  expect(await page.evaluate(() => !!document.querySelector('#unused').getContext('2d'))).toBe(true);
  const missing = await xr.diagnostics({ canvas: '#absent' });
  expect(missing.rendering.canvas).toBeNull();
  expect(missing.rendering.canvasReason).toContain('No canvas matches');
});

test('exposed empty layer lists differ from unavailable or unidentified layers', async ({ page, xr }) => {
  await page.addScriptTag({ path: require.resolve('webxr-layers-polyfill/build/webxr-layers-polyfill.js') });
  await page.evaluate(() => { new WebXRLayersPolyfill(); });
  await xr.enterVR();
  const empty = await xr.diagnostics({ canvas: '#world' });
  expect(empty.rendering.layers).toEqual([]);
  expect(empty.rendering.projectionLayerCount).toBe(0);
  expect(empty.rendering.layersReason).toBeNull();
  // The polyfill's projection type is not exported as a global constructor.
  // Do not guess its type from a minifier-dependent constructor name.
  await page.evaluate(() => {
    const gl = document.querySelector('#world').getContext('webgl2');
    const binding = new XRWebGLBinding(window.session, gl);
    const layer = binding.createProjectionLayer();
    window.session.updateRenderState({ layers: [layer] });
  });
  const unknown = await xr.diagnostics({ canvas: '#world' });
  expect(unknown.rendering.layers).toEqual([{ type: 'unknown' }]);
  expect(unknown.rendering.projectionLayerCount).toBeNull();
  expect(unknown.rendering.projectionLayerCountReason).toContain('cannot be identified');
});

test('a session without frames returns unknown with a reason and bounded wait', async ({ page, xr }) => {
  await page.goto('https://xr.test/?noFrames');
  await xr.enterVR();
  const diagnostics = await xr.diagnostics({ canvas: '#world', timeout: 150 });
  expect(diagnostics.session.mode).toBe('immersive-vr');
  expect(diagnostics.rendering.views).toBeNull();
  expect(diagnostics.rendering.viewsReason).toContain('Timed out');
});

test('a session ending during diagnostics does not leave a hanging frame request', async ({ page, xr }) => {
  await page.goto('https://xr.test/?noFrames');
  await xr.enterVR();
  await page.evaluate(() => setTimeout(() => window.session.end(), 50));
  const diagnostics = await xr.diagnostics({ canvas: '#world', timeout: 1_000 });
  expect(diagnostics.session).toBeNull();
  expect(diagnostics.rendering.views).toBeNull();
  expect(diagnostics.rendering.viewsReason).toContain('Session ended');
});

test('screenshots select a canvas and preserve the path return by default', async ({ page, xr }, testInfo) => {
  const path = testInfo.outputPath('selected.png');
  await xr.enterVR();
  const info = await xr.screenshot(path, { canvas: '#world', metadata: true });
  const png = await fs.readFile(path);
  expect(png.subarray(1, 4).toString()).toBe('PNG');
  expect(png.readUInt32BE(16)).toBe(info.width);
  expect(png.readUInt32BE(20)).toBe(info.height);
  const pixel = await page.evaluate(async base64 => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const sample = new OffscreenCanvas(image.width, image.height).getContext('2d');
    sample.drawImage(image, 0, 0);
    return Array.from(sample.getImageData(image.width / 2, image.height / 2, 1, 1).data);
  }, png.toString('base64'));
  expect(pixel).toEqual([255, 0, 0, 255]);
  expect(info).toMatchObject({ path, canvas: '#world', capture: 'canvas' });
  expect(info.sessionId).toBe((await xr.waitForSessionEvent('granted'))[0].sessionId);
  expect(await xr.screenshot(testInfo.outputPath('legacy.png'))).toBe(testInfo.outputPath('legacy.png'));
  await expect(xr.screenshot(path, { canvas: '#absent' })).rejects.toThrow(/no canvas matches/);
  await page.evaluate(() => { document.querySelector('#unused').width = 0; });
  await expect(xr.screenshot(path, { canvas: '#unused' })).rejects.toThrow(/no encodable pixels/);
});

test('screenshot has a timeout when window animation frames stop', async ({ page, xr }, testInfo) => {
  await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
  await expect(xr.screenshot(testInfo.outputPath('stalled.png'), { timeout: 100 })).rejects.toThrow(/timed out waiting for a frame/);
});
