import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const iwerPath = require.resolve('iwer/build/iwer.min.js');
const polyPath = require.resolve('webxr-layers-polyfill/build/webxr-layers-polyfill.min.js');

const browser = await chromium.launch({ args: ['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist','--no-sandbox'] });
const page = await browser.newPage({ viewport: {width: 1280, height: 800} });
await page.addInitScript(() => {
  const og = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/.test(type)) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return og.call(this, type, attrs);
  };
});
await page.addInitScript({ path: iwerPath });
await page.addInitScript({ path: polyPath });
await page.addInitScript(() => {
  const { XRDevice, metaQuest3 } = globalThis.IWER;
  const cfg = Object.assign({}, metaQuest3, { supportedFeatures: [...(metaQuest3.supportedFeatures||[]), 'layers'] });
  const device = new XRDevice(cfg);
  device.installRuntime({ forceInstall: true });
  new globalThis.WebXRLayersPolyfill();
  device.stereoEnabled = false; device.ipd = 0;
  globalThis.__xrDevice = device;
  const sys = navigator.xr; const orig = sys.requestSession.bind(sys);
  sys.requestSession = (mode, init) => orig(mode, init).then(s => { globalThis.__xrSession = s; return s; });
  globalThis.__capture = (mode) => new Promise((res) => {
    const c = document.querySelector('canvas');
    const grab = () => {
      const d = c.toDataURL('image/png');
      const t = document.createElement('canvas'); t.width = 64; t.height = 40;
      const x = t.getContext('2d');
      const img = new Image();
      img.onload = () => {
        x.drawImage(img, 0, 0, 64, 40);
        const p = x.getImageData(0, 0, 64, 40).data;
        let s = 0; for (let i = 0; i < p.length; i += 4) s += (p[i] + p[i+1] + p[i+2]);
        res({ dataUrl: d, lum: s / (p.length / 4) / 765 });
      };
      img.src = d;
    };
    if (mode === 'raf') requestAnimationFrame(grab);
    else if (mode === 'sraf') globalThis.__xrSession.requestAnimationFrame(() => grab());
    else globalThis.__xrSession.requestAnimationFrame(() => setTimeout(grab, 0));
  });
});
if (!process.env.STAGING_URL) { console.error('menucap: set STAGING_URL'); process.exit(1); }
await page.goto(process.env.STAGING_URL);
const vrBtn = page.locator('button:has-text("VRでプレイ開始")').first();
await vrBtn.waitFor({ state: 'visible', timeout: 120000 });
await vrBtn.click();
await page.waitForFunction(() => { const vr = globalThis.Module?.ysfwVr; return !!(vr && vr.menuRes && vr.menuRes.quad); }, undefined, { timeout: 60000 });
await page.waitForTimeout(8000);
for (const mode of ['raf']) {
  const r = await page.evaluate((m) => globalThis.__capture(m), mode);
  if (r && r.dataUrl) {
    fs.writeFileSync('out/ysf_menu_' + mode + '.png', Buffer.from(r.dataUrl.split(',')[1], 'base64'));
    console.log(mode + ': lum=' + r.lum.toFixed(4));
  } else console.log(mode + ': no data');
}
await browser.close();
