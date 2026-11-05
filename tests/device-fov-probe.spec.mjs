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
