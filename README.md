# playwright-webxr

Playwright fixture for testing **WebXR apps in CI** — no headset required. Wraps Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Immersive Web Emulation Runtime) into a `@playwright/test` fixture: enter `immersive-vr` sessions in headless Chromium, drive headset/controller poses from test code, and capture frames for visual assertion.

Status: **MVP** (2026-07-29). First real-world catch on day one: a billboard shader that follows head-roll — the class of bug that normally requires putting on a Quest to notice.

## Why

Every project that tests WebXR in CI today hand-rolls the same glue (Babylon.js, VTK, elizaOS all built private variants). This package aims to be the turnkey version: install, import, write a test.

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
- `stereoEnabled = false` + `ipd = 0` renders mono — screenshots become one judgeable image instead of a stereo pair.
- Two CLI-roundtrip clicks are too slow to register as `dblclick`; dispatch real events or use element-targeted actions.
- Assertions on UI text must be locale-aware (`locale` in config), or they silently wait forever on the "wrong" language.

## Limitations / roadmap

- IWER does not emulate multiview / MSAA>1 — bugs specific to those paths cannot be caught here ([IWER #196](https://github.com/meta-quest/immersive-web-emulation-runtime/issues/196))
- Frame-boundary determinism is best-effort; visual comparison should use diff tolerances
- Planned: ActionRecorder session replay (record on a real Quest, replay in CI), GitHub Actions template, npm publish, framework sample matrix (three.js / Babylon / react-three/xr)

## License

MIT
