// ysflight-web VR menu ◎-offset mechanical cross-check (no headset, no screenshots).
//
// The Quest round-5 report: "the beam doesn't reach the board and the ring
// doesn't sit on the ray extension". The board (menu), the ring overlay and
// the beams are three INDEPENDENT quad layers sharing vr.menuAnchor. This
// probe checks, under an emulated session, whether the chain is self-
// consistent:
//   [T] the three quad transforms (menu / cursor overlay / anchor) coincide
//   [R] the ◎ ring painted into the cursor canvas (same u/v as the mouse)
//   [B] the beam quad's pose, reprojected onto the board plane
// If T/R/B agree here, the app math is self-consistent and the Quest symptom
// points at device-side differences; a disagreement here IS the bug.
//
//   node scripts/reticle-probe.mjs
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const iwerPath = require.resolve('iwer/build/iwer.min.js');
const polyPath = require.resolve('webxr-layers-polyfill/build/webxr-layers-polyfill.min.js');

const URL = process.env.STAGING_URL ?? 'https://ysflight-web-staging.toming.workers.dev/index.html';

const browser = await chromium.launch({
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { const t = m.text(); if (/\[vr\] menu|overlay failed|beam/.test(t)) console.log('PAGE:', t.slice(0, 160)); });
await page.addInitScript({ path: iwerPath });
await page.addInitScript({ path: polyPath });
await page.addInitScript(() => {
  const { XRDevice, metaQuest3 } = globalThis.IWER;
  const cfg = Object.assign({}, metaQuest3, { supportedFeatures: [...(metaQuest3.supportedFeatures || []), 'layers'] });
  const device = new XRDevice(cfg);
  device.installRuntime({ forceInstall: true });
  new globalThis.WebXRLayersPolyfill();
  device.stereoEnabled = false;
  device.ipd = 0;
  globalThis.__xrDevice = device;
});
await page.goto(URL);
const vrBtn = page.locator('button:has-text("VRでプレイ開始"), button:has-text("Play in VR")').first();
await vrBtn.waitFor({ state: 'visible', timeout: 120_000 });
await vrBtn.click();
await page.waitForFunction(
  () => { const vr = globalThis.Module?.ysfwVr; return !!(vr && vr.menuRes && vr.menuRes.quad); },
  undefined, { timeout: 90_000 },
);
// Let cursor/beam layers come up and a few frames flow.
await page.waitForTimeout(6000);

// Aim the right controller from beside the head straight at the board.
await page.evaluate(() => {
  const d = globalThis.__xrDevice;
  const c = d.controllers.right;
  // Slightly right of and below the head, aiming straight ahead (-Z): the
  // menu spawns centred in front of the head, so this lands ON the board.
  c.position.set(d.position.x + 0.12, d.position.y - 0.18, d.position.z - 0.1);
  c.quaternion.set(0, 0, 0, 1);
});
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const vr = globalThis.Module.ysfwVr;
  const out = { checks: {} };

  const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
  const rot = (v, q) => {
    // v' = q v q*
    const { x, y, z, w } = q;
    const ix = w * v.x + y * v.z - z * v.y;
    const iy = w * v.y + z * v.x - x * v.z;
    const iz = w * v.z + x * v.y - y * v.x;
    const iw = -x * v.x - y * v.y - z * v.z;
    return {
      x: ix * w + iw * -x + iy * -z - iz * -y,
      y: iy * w + iw * -y + iz * -x - ix * -z,
      z: iz * w + iw * -z + ix * -y - iy * -x,
    };
  };
  const vdiff = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const qdiffDeg = (a, b) => {
    const dot = Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w);
    return (2 * Math.acos(Math.min(1, dot))) * 180 / Math.PI;
  };
  const xf = (t) => t ? { p: { x: t.position.x, y: t.position.y, z: t.position.z }, q: { x: t.orientation.x, y: t.orientation.y, z: t.orientation.z, w: t.orientation.w } } : null;

  // ---- [T] transform coherence -------------------------------------------
  const anchor = vr.menuAnchor ? { p: vr.menuAnchor.pos, q: vr.menuAnchor.quat } : null;
  const menuT = xf(vr.menuRes?.quad?.transform);
  const curT = xf(vr.cursorRes?.quad?.transform);
  out.anchor = anchor;
  out.quadSizes = {
    menu: vr.menuRes?.quad ? { w: vr.menuRes.quad.width, h: vr.menuRes.quad.height } : null,
    cursor: vr.cursorRes?.quad ? { w: vr.cursorRes.quad.width, h: vr.cursorRes.quad.height } : null,
    metric: { w: vr.menuRes?.quadW, h: vr.menuRes?.quadH },
  };
  if (anchor && menuT) out.checks.menuVsAnchor = { dPos: vdiff(anchor.p, menuT.p), dRotDeg: qdiffDeg(anchor.q, menuT.q) };
  if (anchor && curT) out.checks.cursorVsAnchor = { dPos: vdiff(anchor.p, curT.p), dRotDeg: qdiffDeg(anchor.q, curT.q) };
  if (menuT && curT) out.checks.cursorVsMenu = { dPos: vdiff(menuT.p, curT.p), dRotDeg: qdiffDeg(menuT.q, curT.q) };

  // ---- [R] ring position from the cursor overlay canvas ------------------
  // Right-hand dot is warm yellow rgba(255,220,80). Centroid over matching px.
  let ringUV = null;
  if (vr.cursorRes?.canvas) {
    const cv = vr.cursorRes.canvas;
    const ctx = vr.cursorRes.ctx;
    const img = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < cv.height; y++) {
      for (let x = 0; x < cv.width; x++) {
        const i = (y * cv.width + x) * 4;
        const r = img[i], g = img[i + 1], b = img[i + 2], a = img[i + 3];
        if (a > 128 && r > 200 && g > 160 && g < 255 && b < 140 && b > 20) { sx += x; sy += y; n++; }
      }
    }
    if (n > 0) ringUV = { u: sx / n / (cv.width - 1), v: sy / n / (cv.height - 1), px: n, canvasW: cv.width, canvasH: cv.height };
  }
  out.ringUV = ringUV;

  // ---- [B] beam quad pose, reprojected onto the board plane --------------
  let beamUV = null, beam = null;
  const bq = vr.beamRes?.right?.quad;
  if (bq && bq.transform && anchor) {
    const bt = xf(bq.transform);
    const dir = rot({ x: 0, y: 1, z: 0 }, bt.q);           // local +Y = along ray
    const halfLen = 3.0;                                    // BEAM_MAX_LEN_M / 2
    const rp = { x: bt.p.x - dir.x * halfLen, y: bt.p.y - dir.y * halfLen, z: bt.p.z - dir.z * halfLen };
    beam = { origin: rp, dir };
    const aQi = qConj(anchor.q);
    const roL = rot({ x: rp.x - anchor.p.x, y: rp.y - anchor.p.y, z: rp.z - anchor.p.z }, aQi);
    const rdL = rot(dir, aQi);
    if (roL.z > 0 && rdL.z < -1e-6) {
      const t = -roL.z / rdL.z;
      const hx = roL.x + t * rdL.x, hy = roL.y + t * rdL.y;
      const W = vr.menuRes.quadW, H = vr.menuRes.quadH;
      beamUV = { u: (hx + W / 2) / W, v: (H / 2 - hy) / H, tMeters: t };
    }
  }
  out.beam = beam;
  out.beamUV = beamUV;

  // ---- [E] expected hit: engine's own pure intersect from beam ray -------
  // (sanity: engine intersect vs my reprojection must agree exactly)
  if (beam && anchor) {
    // Build a quaternion mapping -Z to beam dir is not needed: call the pure
    // hook with a synthetic orientation — instead reuse beamUV as engine
    // formula replica; cross-check with vr.intersectRayWithAnchoredQuad by
    // constructing the ray orientation from dir.
    const z = { x: -beam.dir.x, y: -beam.dir.y, z: -beam.dir.z }; // local +Z = -dir
    let up = Math.abs(z.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const xAxis = { x: up.y * z.z - up.z * z.y, y: up.z * z.x - up.x * z.z, z: up.x * z.y - up.y * z.x };
    const xl = Math.hypot(xAxis.x, xAxis.y, xAxis.z);
    xAxis.x /= xl; xAxis.y /= xl; xAxis.z /= xl;
    const yAxis = { x: z.y * xAxis.z - z.z * xAxis.y, y: z.z * xAxis.x - z.x * xAxis.z, z: z.x * xAxis.y - z.y * xAxis.x };
    // matrix->quat (trace method)
    const m00 = xAxis.x, m01 = yAxis.x, m02 = z.x, m10 = xAxis.y, m11 = yAxis.y, m12 = z.y, m20 = xAxis.z, m21 = yAxis.z, m22 = z.z;
    const tr = m00 + m11 + m22;
    let q;
    if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = { w: 0.25 * s, x: (m21 - m12) / s, y: (m02 - m20) / s, z: (m10 - m01) / s }; }
    else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = { w: (m21 - m12) / s, x: 0.25 * s, y: (m01 + m10) / s, z: (m02 + m20) / s }; }
    else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = { w: (m02 - m20) / s, x: (m01 + m10) / s, y: 0.25 * s, z: (m12 + m21) / s }; }
    else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = { w: (m10 - m01) / s, x: (m02 + m20) / s, y: (m12 + m21) / s, z: 0.25 * s }; }
    const hit = vr.intersectRayWithAnchoredQuad(beam.origin, q, anchor.p, anchor.q, vr.menuRes.quadW, vr.menuRes.quadH);
    out.engineHitUV = hit ? { u: hit.u, v: hit.v } : null;
  }

  // ---- deltas -------------------------------------------------------------
  if (out.ringUV && out.beamUV) {
    out.checks.ringVsBeam = {
      dU: Math.abs(out.ringUV.u - out.beamUV.u),
      dV: Math.abs(out.ringUV.v - out.beamUV.v),
      dMillimetersOnBoard: Math.hypot(
        (out.ringUV.u - out.beamUV.u) * vr.menuRes.quadW,
        (out.ringUV.v - out.beamUV.v) * vr.menuRes.quadH,
      ) * 1000,
    };
  }
  if (out.engineHitUV && out.beamUV) {
    out.checks.engineVsReproject = {
      dU: Math.abs(out.engineHitUV.u - out.beamUV.u),
      dV: Math.abs(out.engineHitUV.v - out.beamUV.v),
    };
  }
  return out;
});

console.log(JSON.stringify(report, null, 1));
await browser.close();
