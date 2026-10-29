# playwright-webxr

Playwright fixture for testing **WebXR apps in CI** — no headset required. Wraps Meta's [IWER](https://github.com/meta-quest/immersive-web-emulation-runtime) (Immersive Web Emulation Runtime) into a `@playwright/test` fixture: enter `immersive-vr` sessions in headless Chromium, drive headset/controller poses from test code, and capture frames for visual assertion.

First real-world catch on day one: a billboard shader that follows head-roll — the class of bug that normally requires putting on a Quest to notice. Since then it has been driven by feedback from projects with about 100 scripts each.

**Use it when** you see any of these:

- `navigator.xr.isSessionSupported('immersive-vr')` resolves `false`, or `requestSession()` rejects with `NotSupportedError`, in headless Chromium or CI.
- The app's "Enter VR" button never appears or does nothing under Playwright.
- You need to move the headset or controllers, press trigger/squeeze/A/B, tilt a thumbstick, grab and drag, or simulate a controller disconnect from a test.
- A press sent with `updateButtonValue()` sometimes never reaches the app on a loaded machine.

For coding agents, [`llms.txt`](llms.txt) (also in the npm package) summarises the API and the mistakes earlier users made.

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
- `xr.endSession({ sessionId?, timeout? })` — call the current session's `end()` and wait for both its promise and its `end` event (default 10,000 ms). Returns `{ sessionId }`. A missing/ended session or mismatched ID is an error; a stale ID never ends a newer session.
- `xr.waitForFrames(count, { sessionId?, timeout? })` — wait for `count` new XR animation frames on the current session (default timeout 10,000 ms). Returns `{ sessionId, frames }`. `count` must be a non-negative safe integer; zero checks the session and returns immediately. See the frame-wait example below.
- `xr.sessionMode()` — current session's requested mode, or `null` before entry/after end. The fixture associates `requestSession(mode)` with its returned session; it does not rely on a nonstandard `XRSession.mode` property.
- `xr.sessionLog()` / `xr.sessionCursor()` / `xr.waitForSessionEvent(event, options?)` — lifecycle history and scoped waits; see below.
- `xr.setHeadPose({ position, euler, quaternion })` — headset position in meters and XYZ Euler angles in radians, or a quaternion.
- `xr.setControllerPose(hand, { position, quaternion })` — place the controller's **target ray**.
- `xr.setGripPose(hand, { position, quaternion? })` / `xr.controllerPose(hand)` — place or read the **grip** (the point a hand holds); see below.
- `xr.pressButton(hand, id, { holdMs?, frames? })` — press and release. The press lasts at least `holdMs` (default 120 ms) **and** `frames` XR frames (default 2); the release is confirmed in a further frame.
- `xr.hold(hand, id, { value?, frames? })` / `xr.release(hand, id)` — keep a button down across other calls (grab, move, let go).
- `xr.drag(hand, { from, to, ms?, steps?, button?, quaternion?, toQuaternion?, space?, release?, settleFrames? })` — hover, grab (`squeeze` by default), move along a straight path, hold the end pose and release in one call.
- `xr.setAxes(hand, x, y)` — set the thumbstick immediately; it stays until changed.
- `xr.holdAxes(hand, x, y, { ms?, frames?, release? })` / `xr.flick(hand, 'left' | 'right' | 'up' | 'down', { magnitude?, frames? })` — tilt, then centre (`release: false` leaves it tilted, frame-synchronised).
- `xr.sequence(steps, { sessionId?, timeout? })` — a timed input script across both hands; see below.
- `xr.disconnect(hand)` / `xr.reconnect(hand)` — controller sleep or tracking loss; resolves after the session's input sources changed.
- `xr.haptics(hand?, { after? })` / `xr.hapticsCursor()` — haptic pulses the app requested: `[{ sequence, hand, actuator, value, duration, t }]`.
- `xr.projectPoint(point, { eye? })` — where a tracking-space point lands in the view; see below.
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

To end a session directly when the app has no exit control, use the fixture API:

```js
await xr.enterVR();
const { sessionId } = await xr.waitForFrames(2);
await xr.endSession({ sessionId, timeout: 5_000 });
expect(await xr.sessionMode()).toBeNull();
```

Both operations bind to the active session **once, at the start of the page
evaluation**. With `sessionId`, a mismatch fails before any exit or frame request.
Without it, they select whichever session is active at that moment. They do not
wait for a future session. Repeating `endSession()` after the session has ended
is an error. Its timeout stops waiting; it cannot undo an already requested exit.
Asynchronous app cleanup must be asserted separately. To test the app's exit UI
itself, keep the click-and-event approach above.

### Waiting for XR frames after a pose change

```js
const { sessionId } = await xr.waitForFrames(0); // capture the active session ID
await xr.setHeadPose({ euler: [0, 0, Math.PI / 8] });
await xr.waitForFrames(2, { sessionId, timeout: 5_000 });
// Assert your app's loaded assets, hover state or simulation readiness here.
await xr.screenshot('head-rolled.png');
```

This schedules successive `XRSession.requestAnimationFrame` callbacks. It counts
only frames after the wait begins, on that same session; DOM animation frames
and frames from a later session do not count. If the session ends or navigation
replaces the document, the wait rejects. Stalled XR rendering (for example, a
session without a configured layer) times out with the observed/requested count.
Pending callbacks and listeners are removed on completion, timeout or exit.

Frame progress does **not** guarantee that the app has rendered, loaded assets,
finished physics, or presented pixels on a headset. Keep application-specific
assertions. `settle(ms)` remains available for tests that intentionally need
elapsed time.

### Aiming a controller at a tracking-space point

The dependency-free [aiming sample](examples/aim-controller.mjs) is included in
the package and can also be copied into your tests:

```js
import { aimQuaternion } from 'playwright-webxr/examples/aim-controller';

const position = [0.3, 1.3, -0.4]; // ray origin, in tracking-space meters
const target = [0, 1.4, -2];       // target in the SAME tracking coordinates
await xr.setControllerPose('right', {
  position,
  quaternion: aimQuaternion(position, target),
});
await xr.waitForFrames(2);
// Assert your app's hover/hit-test result before pressing, if applicable.
await xr.pressButton('right', 'trigger');
```

WebXR's [target ray](https://immersive-web.github.io/webxr/#dom-xrinputsource-targetrayspace)
points along local **-Z**. IWER controller poses position/orient that target ray;
the controller's grip can have a profile-specific offset. The sample returns an
`[x, y, z, w]` quaternion with the shortest rotation from -Z, including the
opposite (+Z) direction. It does not preserve wrist roll. Coincident points and
non-finite coordinates are errors.

For a scene-world target, first apply the inverse of your app's complete
tracking-to-world transform, including the camera rig and any reference-space
offset. For example, in Three.js, if `trackingToWorld` is that `Matrix4`:

```js
const targetTracking = targetWorld.clone()
  .applyMatrix4(trackingToWorld.clone().invert()).toArray();
const quaternion = aimQuaternion(position, targetTracking);
```

Do not pass a world-space or viewer-relative point directly. In IWER, `local`
space is based on the headset transform when the reference space is requested;
it need not equal the tracking coordinates used by `setControllerPose()`.

### Controller input on slow pages

IWER applies a button value at the start of the **next XR frame**, and only the
last value written before that frame counts. A press and release written
between two frames — easily the case on a loaded machine, where one frame can
take longer than a fixed hold — reach the app as no press at all.

All controller input helpers therefore run as one page evaluation driven by XR
animation frames: values are written, then the helper waits until IWER has
applied them in the requested number of frames. Neither a slow page nor a slow
test process can drop or merge steps. An active session is required; unknown
hands, button IDs and axes are errors (IWER itself only logs a warning).

```js
// Press: at least 2 XR frames down, then released in a later frame.
await xr.pressButton('right', 'trigger');

// Grab, move, let go — the app sees intermediate poses, never a teleport.
await xr.drag('right', { from: [0.2, 1.3, -0.4], to: [0.4, 1.3, -0.4], ms: 300 });

// Or step by step when something else must happen while held.
await xr.hold('left', 'squeeze');
await xr.setControllerPose('left', { position: [-0.1, 1.4, -0.5] });
await xr.waitForFrames(2);
await xr.release('left', 'squeeze');

// "One tilt, one action" and repeat-rate behaviour.
await xr.flick('right', 'right');                 // x = 1 for 2 frames, then centre
await xr.holdAxes('right', 0, -1, { ms: 600 });   // up for at least 600 ms
```

`drag()` sets the start pose and waits a frame (hover), presses, interpolates
over at least `ms` **and** at least `steps` frames (default 5), holds the end
pose for `settleFrames` frames (default 2, so apps that follow the hand a frame
late still arrive) and releases (`release: false` keeps the button down). With
`quaternion`/`toQuaternion` it also rotates. Durations are minimums: on a
slow page the same path takes more wall time, not fewer frames.

For input that spans both hands or needs timing between steps, write the
script once; it runs in the same frame-driven evaluation:

```js
// Record what the app sees for 30 XR frames while the script runs. A recorder
// that throws inside a frame callback must reject; otherwise the promise never
// settles and the test waits silently until its timeout.
const recording = page.evaluate(count => new Promise((resolve, reject) => {
  const session = window.mySession;            // however your app exposes it
  const frames = [];
  const timer = setTimeout(() => reject(new Error(`recorder: ${frames.length}/${count} frames`)), 10_000);
  const tick = (_time, frame) => {
    try {
      frames.push(window.myApp.snapshot(frame)); // your app state
      if (frames.length === count) { clearTimeout(timer); resolve(frames); }
      else session.requestAnimationFrame(tick);
    } catch (error) {
      clearTimeout(timer);
      reject(error);                            // surface it instead of hanging
    }
  };
  session.requestAnimationFrame(tick);
}), 30);

// Let go with the left hand, then tilt the right stick about 50 ms later.
await xr.sequence([
  { button: ['left', 'squeeze', 0] }, { frames: 1 },
  { wait: 50 },
  { axes: ['right', 0, -1] }, { frames: 2 },
  { axes: ['right', 0, 0] }, { frames: 1 },
]);
const frames = await recording;
```

IWER catches exceptions from XR frame callbacks and only logs them to the
console. A recorder without the `try`/`catch` therefore either stops
requesting frames or keeps throwing in every frame; in both cases its promise
never settles. Neither the fixture nor `sequence()` can see that.
Keep the recorder's own timeout shorter than the test's.

Steps are `{ button: [hand, id, value] }`, `{ axes: [hand, x, y], id? }`
(`id` defaults to `'thumbstick'`), `{ pose: hand, position?, quaternion? }`,
`{ connected: [hand, boolean] }`, `{ frames: n, ms? }` and `{ wait: ms }`.
Value steps are written immediately and take effect at the start of the next
XR frame, so follow a value the app must see with a `frames` or `wait` step.
Waits are checked once per XR frame: timing resolution is one frame, which is
also the finest resolution at which the app can observe input.

Read back app state in **one** `page.evaluate()` per snapshot. Several
evaluations in a row can straddle XR frames and mix values from different
frames.

### Grip and target ray

`setControllerPose()` places the **target ray** (WebXR `targetRaySpace`). The
grip (`gripSpace`) is a child of it, offset by the device profile. For IWER's
Meta Quest profiles the grip sits about 5 cm from the target ray origin
(about (±0.4, −1.6, +5.0) cm in the ray's own axes) and is pitched about 45°
with about 7° of yaw, so it **rotates with the hand**: the grip's −X is not
the world's −X once the hand turns. Apps that grab or sculpt at the grip
otherwise need a per-test calibration.

```js
// Put the grip itself on a vertex; the current hand orientation is kept.
await xr.setGripPose('right', { position: [0.1, 1.2, -0.3] });
// Or give the grip an orientation as well.
await xr.setGripPose('right', { position: [0.1, 1.2, -0.3], quaternion: [0, 0, 0, 1] });
// Drag in grip coordinates.
await xr.drag('right', { from: [0.1, 1.2, -0.3], to: [0.1, 1.4, -0.3], space: 'grip' });
// With space: 'grip', quaternion/toQuaternion are GRIP orientations.
await xr.drag('right', { from, to, space: 'grip', quaternion: gripQuaternion });
const { targetRay, grip, connected } = await xr.controllerPose('right');
```

All positions are in IWER tracking coordinates, the same as `setControllerPose()`.
Orientation follows the same rule as positions: with `space: 'grip'` (and in
`setGripPose()`), a quaternion is the grip's orientation. When it is omitted,
the **target ray's** current orientation is kept, so the grip keeps its
profile tilt relative to it.

### Disconnects and haptics

```js
await xr.disconnect('right');   // session.inputSources no longer has it
// assert that the app did not commit a half-finished edit, etc.
await xr.reconnect('right');

await xr.pressButton('right', 'trigger');   // an app that pulses on press
expect(await xr.haptics('right')).toHaveLength(1);
```

`haptics()` records `pulse()` calls on every actuator, including those reached
through `gamepad.vibrationActuator`. It records requests; nothing vibrates.
To look only at pulses caused by one action, save a cursor first:

```js
const before = await xr.hapticsCursor();
await xr.pressButton('right', 'trigger');
await expect.poll(async () => (await xr.haptics('right', { after: before })).length).toBe(2);
```

Apps often schedule a second pulse with a timer; poll instead of reading once.

### How big things look

The emulator renders a 90° vertical field of view into your viewport: at
960 × 540 that is about 4.7 px per degree at the centre, while a Quest 3 shows
roughly 25 px per degree. Judge legibility in **degrees**, not emulator pixels:

```js
const label = await xr.projectPoint([0, 1.5, -1]);
// { eye, ndc: [x, y, z], inView, behind, pixel: [x, y] | null,
//   degreesFromCenter, pixelsPerDegree, viewport }
expect(label.inView).toBe(true);
expect(label.degreesFromCenter).toBeLessThan(25);
// Text height in degrees: project its top and bottom and compare the angles,
// or divide its pixel height by pixelsPerDegree.
```

The point is in tracking coordinates. Projection uses one XR frame's viewer
pose and projection matrix; `pixel` is in canvas pixels with a top-left origin
and is `null` without a base-layer viewport (for example, with projection
layers). `eye` defaults to the first eye with a non-empty viewport.

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

## Installing from a local checkout

`file:` dependencies and `npm link` symlink this package. Node then resolves
`@playwright/test` from the symlink's **real path**, finds the copy in this
repository's own `node_modules`, and Playwright fails because it was loaded
twice. Install a packed tarball instead:

```sh
(cd ../playwright-webxr && npm pack)              # writes playwright-webxr-<version>.tgz
npm i -D ../playwright-webxr/playwright-webxr-<version>.tgz   # or: bun add -d <same path>
```

The symptom is `Playwright Test did not expect test() to be called here` (or a
similar duplicate-load error). `NODE_OPTIONS=--preserve-symlinks` does not
avoid it. Repack after each change to the checkout.

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

- **Request `xr` before the first `page.goto()`.** Fixtures are lazy: the runtime is installed with `page.addInitScript()` when `xr` is first requested, which only affects documents loaded afterwards. A `beforeEach(({ page }) => page.goto(...))` that does not take `xr` loads the page without the runtime. Write `test.beforeEach(async ({ page, xr }) => ...)`. Helpers now say so when the runtime is missing.
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
