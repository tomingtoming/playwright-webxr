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

test('my world in emulated VR', async ({ page, xr }, testInfo) => {
  await page.goto('https://example.com/my-webxr-app/');
  await xr.enterVR();                                   // clicks the app's own VR button
  await xr.setHeadPose({ euler: [0, 0, 25 * Math.PI / 180] });  // roll the head 25°
  await xr.setAxes('left', 0, -1);                      // push left thumbstick
  await xr.pressButton('right', 'trigger');
  await xr.screenshot(testInfo.outputPath('rolled.png'));                 // robust WebGL canvas capture
});
```

Choose a rendering configuration for your environment. A local Chrome run can
use the machine's GPU without forcing a software backend:

```js
// playwright.config.mjs — local Chrome
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1280, height: 960 },
  },
});
```

For a CI runner without a GPU, explicitly select SwiftShader:

```js
// playwright.config.mjs — software rendering
import { defineConfig } from '@playwright/test';

export default defineConfig({
  use: {
    headless: true,
    viewport: { width: 1280, height: 960 },
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
});
```

The actual backend depends on the OS, browser and driver. Check
`(await xr.diagnostics({ canvas: '#world' })).gpu` instead of inferring it from
launch flags. Software rendering is allowed; its performance and supported
extensions may differ from a hardware GPU.

## API

- `xr.enterVR({ button?, force?, timeout? })` — wait for a visible app entry button, click it and confirm a **new, live immersive-vr session**. `button` is a Playwright selector; defaults cover three.js `#VRButton` and common ENTER VR text. One timeout covers discovery, clicking and session entry (default 10,000 ms). Normal [Playwright actionability checks](https://playwright.dev/docs/actionability) apply; `force: true` is opt-in. Errors distinguish absent/hidden buttons, click failures, rejected requests and sessions that immediately ended.
- `xr.waitForSession(timeout?)` — wait for any currently live session (default 10,000 ms).
- `xr.sessionMode()` — current session's requested mode, or `null` before entry/after end. The fixture associates `requestSession(mode)` with its returned session; it does not rely on a nonstandard `XRSession.mode` property.
- `xr.sessionLog()` / `xr.sessionCursor()` / `xr.waitForSessionEvent(event, options?)` — lifecycle history and scoped waits; see below.
- `xr.setHeadPose({ position, euler, quaternion })` — headset position in meters and XYZ Euler angles in radians, or a quaternion.
- `xr.setControllerPose(hand, { position, quaternion })`
- `xr.pressButton(hand, id, { holdMs? })` / `xr.setAxes(hand, x, y)` — controller input (`trigger`, `squeeze`, `a-button`, … / thumbstick). Default button hold is 120 ms.
- `xr.diagnostics({ canvas?, timeout? })` — runtime, current session, render state, input sources, selected canvas and GPU; see below.
- `xr.screenshot(path, { canvas?, timeout?, metadata? })` — PNG canvas capture; see below.
- `xr.runtimeInstalled()` — whether the emulated device is installed.
- `xr.settle(ms = 500)` — wait that many milliseconds. It does **not** count frames or guarantee rendering, physics or asset readiness; assert the app state separately.

Fixture options (set with `test.use()` or Playwright config `use`):

| Option | Default | Meaning |
| --- | --- | --- |
| `xrDeviceName` | `'metaQuest3'` | IWER device profile |
| `xrStereoEnabled` | `false` | Mono or side-by-side stereo |
| `xrIpd` | `null` | Eye separation in meters; `null` selects 0 for mono and 0.064 for stereo. Explicit non-negative values, including 0, are preserved. |

### Entry, exit and re-entry

Events contain `event`, `detail`, `t` (milliseconds since document initialization),
`sequence`, `requestId`, `sessionId` and `mode`. `sequence` increases with every
event; `sessionId` is assigned only on grant. Requests and rejections have
`sessionId: null` and can be correlated with grants by `requestId`.

```js
await xr.enterVR();
const [granted] = await xr.waitForSessionEvent('granted');
const beforeExit = await xr.sessionCursor();
await page.getByRole('button', { name: 'Exit VR' }).click(); // your app's exit control
await xr.waitForSessionEvent('end', {
  after: beforeExit,
  sessionId: granted.sessionId,
  timeout: 5_000,
});
expect(await xr.sessionMode()).toBeNull();

const beforeReentry = await xr.sessionCursor();
await xr.enterVR();
const [next] = await xr.waitForSessionEvent('granted', { after: beforeReentry });
expect(next.sessionId).not.toBe(granted.sessionId);
```

`after` is exclusive. Without it, waits search all history in the current
document, preserving the original behavior for short-lived sessions.
`waitForSessionEvent('end', 5000)` still accepts a numeric timeout and returns
an array of matching events. Supported events are `request`, `granted`,
`rejected`, `end-called` and `end`. The `end-called` stack and optional
`window.__xrEndProbe` remain available. IDs/cursors reset on navigation and
must not be reused across documents. To examine a session that immediately
ends, click the app button yourself and wait on its events; `enterVR()`
intentionally reports that it is no longer live.

### Mono and stereo capture dimensions

The fixture does not resize the app's canvas. Keep the intended **per-eye**
aspect ratio by setting the total viewport/canvas size appropriately. For an
app that sizes its canvas to the Playwright viewport at device scale factor 1:

| Configuration | Total canvas | Left viewport | Right viewport | IPD |
| --- | --- | --- | --- | --- |
| Mono (default) | 1280 × 960 | 1280 × 960 | 0 × 960 | 0 m |
| Stereo | 2560 × 960 | 1280 × 960 | 1280 × 960 | 0.064 m |

IWER 2.3.0/2.4.0 returns **two views even in mono**, with a zero-width right
viewport. `views.length` is not the number of rendered eyes. Turning on stereo
while keeping a 1280 × 960 total canvas gives each eye 640 × 960.

```js
import { test, expect } from 'playwright-webxr';

test.use({
  xrStereoEnabled: true, // false for mono; use width: 1280 below
  xrIpd: 0.064,          // 0 for mono; omit to use the mode-dependent default
  viewport: { width: 2560, height: 960 },
  deviceScaleFactor: 1,
});

test('inspect stereo dimensions', async ({ page, xr }) => {
  await page.goto('https://example.com/my-webxr-app/');
  await xr.enterVR();
  const d = await xr.diagnostics({ canvas: '#world' });
  console.log({ canvas: d.rendering.canvas, views: d.rendering.views, ipd: d.runtime.ipd });
  for (const view of d.rendering.views ?? []) {
    if (view.viewport?.width > 0) {
      expect(view.viewport.width / view.viewport.height).toBeCloseTo(4 / 3);
    }
  }
});
```

### Diagnostics

`await xr.diagnostics({ canvas: '#world', timeout: 2000 })` returns:

| Field | Evidence |
| --- | --- |
| `runtime` | Installed package/IWER versions, device profile, stereo flag, actual IPD, browser version, emulated user agent and original user agent |
| `session` | Current session ID/mode, visibility and exposed `enabledFeatures`; `null` when inactive |
| `rendering.baseLayer` | Active base-layer type and framebuffer dimensions, or `null` |
| `rendering.layers` | Layers in the session's render state; `null` when the runtime does not expose this property |
| `rendering.projectionLayerCount` | Count of identified projection layers; `null` when the layer list or a layer type is unknown |
| `rendering.canvas` | Selected canvas's actual pixel dimensions and whether it matches IWER's base-layer canvas |
| `rendering.views` | A sampled XR frame's eyes and `baseLayer.getViewport(view)` rectangles; unavailable viewports stay `null` |
| `inputSources` | Handedness, target ray mode and profiles |
| `gpu` | Renderer/vendor and unmasked values where available, from the selected canvas's existing WebGL context |

Unavailable data is `null` with an accompanying `reason`/`*Reason`, rather than
being treated as zero, false or success. In plain IWER, `renderState.layers`
is not exposed: that is **unknown**, not evidence that zero projection layers
were used. An exposed empty array does prove the render state has no layers.
The presence of a binding API or a granted `layers` feature alone does not
prove the app is using projection layers.

Layer types are identified through runtime constructors. The layers polyfill
does not expose all such constructors, so its unidentified layers have type
`'unknown'` and an unknown projection count. The list still records how many
layers the app put in its render state; it does not invent a layer type.

Diagnostics observes app-created canvas contexts; it does not call
`getContext()` to create one. A canvas with no observed WebGL context reports
an unknown GPU. XR frame sampling is bounded by `timeout` and stops on session
end. Projection-layer subimage viewports are not sampled; a missing base-layer
viewport is reported explicitly. This is a snapshot of render configuration,
not a proof that every layer's pixels were displayed by the compositor.

### Screenshots

```js
const path = testInfo.outputPath('vr.png');
await xr.screenshot(path); // first canvas; returns path, as before
const capture = await xr.screenshot(path, {
  canvas: '#world',
  timeout: 5_000,
  metadata: true,
});
// { path, width, height, canvas, sessionId, capture: 'canvas' }
```

The parent directory must exist. Capture uses `canvas.toDataURL()` inside a
window animation frame, with errors for missing/empty/tainted canvases and a
bounded wait if frames stop. Image dimensions are recorded in that same
callback. It captures the selected canvas only: **composition layers may not
reach that canvas**. Saving a PNG does not verify layer textures or the final
headset image. Keep app-specific texture/FBO evidence alongside it when needed.
Eye cropping is not provided; use actual diagnosed viewports, not an assumed
half-image split.

## Development and regression tests

```sh
npm ci
npx playwright install chromium
npm test                                  # self-contained, software GL
PW_CHANNEL=chrome XR_GPU=hardware npm test # installed Chrome; inspect GPU diagnostics
```

The fixture tests use a local routed WebXR page, with no app server or headset.
They cover lifecycle/re-entry, rejection and entry failures, mono/stereo
viewports, diagnostics and canvas capture. GitHub Actions runs the suite with
IWER 2.3.0 and 2.4.0. Optional app integration tests require `CAELUM_URL` or
`STAGING_URL`; they are skipped in the default suite.

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
