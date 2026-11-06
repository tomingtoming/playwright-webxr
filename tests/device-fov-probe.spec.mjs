import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '../src/index.mjs';

// The probe is a one-shot tool for real headsets; this proves its arithmetic and
// delivery against IWER, whose frustum is known.
test('device-fov probe records the known emulator frustum through its server', async ({ page, xr }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fov-probe-'));
  const output = path.join(dir, 'results.jsonl');
  const server = spawn(process.execPath, [new URL('../scripts/device-fov/server.mjs', import.meta.url).pathname, output], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const line = await new Promise((resolve, reject) => {
      server.stdout.once('data', data => resolve(String(data)));
      server.once('exit', code => reject(new Error(`server exited ${code}`)));
    });
    const [, port, urlPath] = line.match(/port=(\d+) path=(\S+)/);
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    await page.goto(`http://127.0.0.1:${port}${urlPath}`);
    await page.evaluate(() => { document.querySelector('[data-device="quest3"]').dataset.device = 'emulator'; });
    await page.click('[data-device="emulator"]');
    await expect(page.locator('#status')).toHaveText(/Recorded emulator/, { timeout: 30_000 });
    expect(await xr.sessionMode()).toBeNull();

    const [result] = (await fs.readFile(output, 'utf8')).trim().split('\n').map(JSON.parse);
    expect(result.frames).toBe(120);
    expect(result.drift).toBe(0);
    const view = result.views.find(v => v.viewport.width > 0);
    // IWER: 90 degrees vertically, symmetric.
    expect(view.frustum.up).toBeCloseTo(45, 3);
    expect(view.frustum.down).toBeCloseTo(-45, 3);
    expect(view.frustum.right).toBeCloseTo(-view.frustum.left, 3);
    expect(Math.tan(view.frustum.right * Math.PI / 180)).toBeCloseTo(view.viewport.width / view.viewport.height, 3);
  } finally {
    server.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('edge chart draws its frame on the render edge and ticks where projection says', async ({ page, xr }) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fov-edges-'));
  const server = spawn(process.execPath, [new URL('../scripts/device-fov/server.mjs', import.meta.url).pathname, path.join(dir, 'r.jsonl')], {
    env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    const line = await new Promise(resolve => server.stdout.once('data', data => resolve(String(data))));
    const [, port, urlPath] = line.match(/port=(\d+) path=(\S+)/);
    await page.goto(`http://127.0.0.1:${port}${urlPath}edges`);
    await xr.enterVR({ button: '#enter' });
    await page.waitForFunction(() => window.framesDrawn >= 2);
    const chart = await page.evaluate(() => {
      const { ticks, viewport } = window.charts.get('left') ?? window.charts.values().next().value;
      return { ticks, viewport };
    });
    expect(chart.ticks.length).toBeGreaterThan(10);

    // Independent check: the same angles through the real projection matrix.
    const samples = chart.ticks.filter(t => [10, -25, 40].includes(t.degrees));
    expect(samples.length).toBeGreaterThanOrEqual(4);
    for (const t of samples) {
      const tan = Math.tan(t.degrees * Math.PI / 180);
      const point = t.axis === 'horizontal' ? [tan, 0, -1] : [0, tan, -1];
      const { pixel } = await xr.projectPoint(point, { space: 'viewer' });
      expect(Math.abs(pixel[0] - t.x)).toBeLessThan(1);
      expect(Math.abs(pixel[1] - t.y)).toBeLessThan(1);
    }

    // What the GPU drew: red on all four edges, white on a known tick.
    const tick = chart.ticks.find(t => t.axis === 'horizontal' && t.degrees === 10);
    const colors = await page.evaluate(({ tick, viewport }) => new Promise((resolve, reject) => {
      window.session.requestAnimationFrame(() => {
        try {
          const { width, height } = viewport;
          const read = (x, y) => {
            const out = new Uint8Array(4);
            gl.bindFramebuffer(gl.FRAMEBUFFER, window.session.renderState.baseLayer.framebuffer);
            gl.readPixels(viewport.x + Math.round(x), viewport.y + height - 1 - Math.round(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
            return Array.from(out);
          };
          resolve({
            left: read(2, height / 3), right: read(width - 3, height / 3),
            top: read(width / 3, 2), bottom: read(width / 3, height - 3),
            tick: read(tick.x, tick.y), inside: read(width / 3, height / 3),
          });
        } catch (error) { reject(error); }
      });
    }), { tick, viewport: chart.viewport });
    for (const side of ['left', 'right', 'top', 'bottom']) {
      expect(colors[side][0]).toBeGreaterThan(200);
      expect(colors[side][1]).toBeLessThan(50);
    }
    expect(colors.tick[1]).toBeGreaterThan(200);
    expect(colors.inside.slice(0, 3)).toEqual([0, 0, 0]);

    // The trigger leaves VR, so nobody is stuck in the chart.
    await xr.pressButton('right', 'trigger').catch(() => {});
    await xr.waitForSessionEvent('end', { timeout: 5_000 });
    expect(await xr.sessionMode()).toBeNull();
  } finally {
    server.kill();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
