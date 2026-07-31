// PC playability probe v2: boot endurance -> press SPACE through the
// "CENTER JOYSTICK / PRESS SPACE TO GO" gate -> real flight: fps, control
// response (pitch/roll), external view, 90s sustain, evidence shots.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

if (!process.env.STAGING_URL) { console.error('pc-play-probe: set STAGING_URL'); process.exit(1); }
const URL = process.env.STAGING_URL + '?endurance=F-15J_EAGLE,SMALL_MAP,0,1,1';
const browser = await chromium.launch({ args: ['--use-angle=vulkan','--enable-features=Vulkan','--ignore-gpu-blocklist','--no-sandbox','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const fatal = [];
const FATAL = [/Aborted\(/, /RuntimeError/, /Failed to create WebGL context/, /GL_INVALID/];
page.on('console', m => { const t = m.text(); if (FATAL.some(re => re.test(t))) fatal.push(t.slice(0,150)); });
page.on('pageerror', e => fatal.push('EXC: ' + String(e).slice(0,150)));
await page.addInitScript(() => {
  const og = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (/webgl/.test(type)) attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true });
    return og.call(this, type, attrs);
  };
});
await page.goto(URL);
await page.waitForFunction(() => globalThis.ysfwInFlight === true, undefined, { timeout: 240_000 });
console.log('flight mode reached');
await page.waitForTimeout(4000);
await page.mouse.click(640, 400);
await page.keyboard.press('Space');   // through the CENTER JOYSTICK gate
await page.waitForTimeout(6000);

const shot = async (name) => {
  const d = await page.evaluate(() => new Promise(res => { const c = document.querySelector('canvas'); requestAnimationFrame(() => res(c.toDataURL('image/png'))); }));
  fs.writeFileSync('out/' + name, Buffer.from(d.split(',')[1], 'base64'));
};
const fps = await page.evaluate(() => new Promise(res => {
  let n = 0; const t0 = performance.now();
  const loop = () => { n++; (performance.now() - t0 < 8000) ? requestAnimationFrame(loop) : res((n / 8).toFixed(1)); };
  requestAnimationFrame(loop);
}));
console.log('FPS in flight (8s avg, RADV):', fps);
await shot('play_11_flying.png');

await page.keyboard.down('ArrowDown');   // pitch
await page.waitForTimeout(1500);
await page.keyboard.up('ArrowDown');
await shot('play_12_pitch.png');

await page.keyboard.down('ArrowLeft');   // roll
await page.waitForTimeout(1500);
await page.keyboard.up('ArrowLeft');
await shot('play_13_roll.png');

await page.keyboard.press('F2');         // outside view
await page.waitForTimeout(1500);
await shot('play_14_outside.png');

await page.waitForTimeout(90_000);       // sustain
const still = await page.evaluate(() => globalThis.ysfwInFlight);
await shot('play_15_sustained.png');
console.log('sustained 90s, inFlight:', still, 'fatal:', fatal.length ? fatal.slice(0,3) : 'none');
await browser.close();
