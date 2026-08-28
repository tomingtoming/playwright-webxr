# playwright-webxr

Playwright fixture for testing **WebXR apps in CI** — no headset required. Wraps Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Immersive Web Emulation Runtime) into a `@playwright/test` fixture: enter `immersive-vr` sessions in headless Chromium, drive headset/controller poses from test code, and capture frames for visual assertion.

Status: **MVP** (2026-07-29). First real-world catch on day one: a billboard shader that follows head-roll — the class of bug that normally requires putting on a Quest to notice.

## Why

Every project that tests WebXR in CI today hand-rolls the same glue (Babylon.js, VTK, elizaOS all built private variants). This package aims to be the turnkey version: install, import, write a test.

## Install

```sh
npm i -D playwright-webxr @playwright/test
```

## Usage

```js
// tests/my-world.spec.mjs
import { test, expect } from 'playwright-webxr';

test('my world in emulated VR', async ({ page, xr }) => {
  await page.goto('https://example.com/my-webxr-app/');
  await xr.enterVR();                                   // clicks the app's own VR button
  await xr.setHeadPose({ euler: [0, 0, 25 * Math.PI / 180] });  // roll the head 25°
  await xr.setAxes('left', 0, -1);                      // push left thumbstick
  await xr.pressButton('right', 'trigger');
  await xr.screenshot('out/rolled.png');                // robust WebGL canvas capture
});
```

Config needs the software-GL flags (proven path used by IWER's own CI, Babylon.js and VTK):

```js
// playwright.config.mjs
export default defineConfig({
  use: {
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    },
  },
});
```

## API (MVP)

- `xr.enterVR({ button? })` — click the app's VR button (defaults find three.js `#VRButton` etc.) and wait for the session
- `xr.setHeadPose({ position, euler, quaternion })` — move/orient the headset
- `xr.setControllerPose(hand, { position, quaternion })`
- `xr.pressButton(hand, id)` / `xr.setAxes(hand, x, y)` — controller input (`trigger`, `squeeze`, `a-button`, … / thumbstick)
- `xr.screenshot(path)` — captures the WebGL canvas via `toDataURL` inside a rAF (`page.screenshot` times out on continuously-rendering canvases under software GL)
- `xr.runtimeInstalled()` / `xr.sessionMode()` / `xr.settle(ms)`
- fixture option `xrDeviceName` (default `metaQuest3`)

## Gotchas learned the hard way

- **`forceInstall` is mandatory in headless Chromium**: it exposes a stub `navigator.xr` that always answers "not supported", and IWER ≥2.3 politely refuses to clobber anything that looks like a native runtime. The fixture passes `{ forceInstall: true }` for you.
- **`--use-angle=vulkan` unlocks a real GPU *and* OVR_multiview2 in headless Chromium** (verified on AMD Radeon 780M via RADV; even SwiftShader's Vulkan backend exposes multiview, unlike its GL backend). Apps whose VR path gates on multiview (single-pass stereo) only work with this backend.
- **IWER 2.3.0 `polyfillLayers` ordering bug**: `installRuntime` instantiates `WebXRLayerPolyfill` *and then* overwrites the global `XRWebGLBinding` with its own class — so `binding.createProjectionLayer` is missing and layers-dependent apps fall back or die. Workaround: `installRuntime({ forceInstall: true })` **without** `polyfillLayers`, then re-apply `new WebXRLayersPolyfill()` (from `webxr-layers-polyfill`) *after* install. Also add `'layers'` to the device profile's `supportedFeatures` so sessions grant the optional feature. (Both worth upstream issues.)
- Layer composition under the polyfill does not reach the visible canvas — don't screenshot the canvas to verify quad-layer content; read the layer texture / app-side FBO hooks instead.
- `stereoEnabled = false` + `ipd = 0` renders mono — screenshots become one judgeable image instead of a stereo pair.
- Two CLI-roundtrip clicks are too slow to register as `dblclick`; dispatch real events or use element-targeted actions.
- Assertions on UI text must be locale-aware (`locale` in config), or they silently wait forever on the "wrong" language.

## What emulation can and cannot prove

**The emulator is a child of the spec; the real device is a child of its
implementation.** A green run here proves your app math agrees with the spec —
as IWER and the layers polyfill read it. It cannot prove the device agrees.

The case that taught us this: on Quest, an app's aim reticle drifted off the
ray everywhere except the board's centre. Five rounds of app-side audits under
emulation kept returning "self-consistent" — pose math, quad transforms, hit
tests, ray reprojection, all agreed to within 1.3mm. They were all correct:
Quest Browser's compositor displays an `XRQuadLayer` at **2× its declared
`width`/`height`** (a half-extent reading), while the spec text — and therefore
IWER + polyfill — reads them as full extents. The emulator agreed with the app
because both were children of the same spec; the bug lived in the divergent
implementation, where no amount of emulated testing could see it.

What resolved it was measuring the device itself: a diagnostic URL knob that
scales only the *declared* layer size (`?vrlayerscale=`), A/B'd on the headset.
At `0.5` the reticle matched the ray across the whole board → the device
applies 2×. One session, conclusive.

Practical rules:

- Use this fixture to pin down **your** math. When it passes and the symptom is
  device-only, stop re-auditing the app — the remaining suspect is the
  implementation, and the next test must run on the device.
- Ship diagnostic knobs in the app (scale factors, layer toggles) so a headset
  A/B takes one URL edit instead of a rebuild. That is what actually converts
  "works in CI, broken on device" into a verdict.
- When emulator and device disagree, one of them diverges from the spec —
  either way it is upstream-reportable, and your app-side "fix" is a
  workaround to annotate as such.

## Limitations / roadmap

- IWER does not emulate multiview / MSAA>1 — bugs specific to those paths cannot be caught here ([IWER #196](https://github.com/meta-quest/immersive-web-emulation-runtime/issues/196))
- Frame-boundary determinism is best-effort; visual comparison should use diff tolerances
- Planned: ActionRecorder session replay (record on a real Quest, replay in CI), GitHub Actions template, framework sample matrix (three.js / Babylon / react-three/xr)

## License

MIT
