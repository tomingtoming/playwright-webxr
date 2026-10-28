# Changelog

## Unreleased

### Documentation

- The concurrent recording example for `sequence()` is now a complete recorder that rejects when its frame callback throws or when it times out. IWER only logs exceptions from XR frame callbacks, so a recorder without this never settled and the test waited silently until its timeout. The example is exercised by a test.

## 0.5.0 — 2026-10-28

### Added

- `sequence(steps)` runs a timed input script across both hands (`button`, `axes`, `pose`, `connected`, `frames`, `wait` steps) in one frame-driven evaluation, alongside the app's own in-page recording.
- `hapticsCursor()` and `haptics(hand, { after })`; haptic entries carry a `sequence`.
- `holdAxes(..., { release: false })` leaves the stick tilted after a frame-synchronised hold.
- `drag(..., { settleFrames })`.

### Changed

- `drag()` holds the end pose for 2 XR frames by default (`settleFrames`) before releasing. With one frame, an app that follows the hand a frame late lost the last segment (0.290 m of a 0.3 m carry).

### Documentation

- With `space: 'grip'`, `drag()` quaternions are grip orientations; when omitted, the target ray's orientation is kept.
- Installing from a local checkout: `file:` links load `@playwright/test` twice; install a packed tarball.

### Upgrade

```sh
npm install -D playwright-webxr@^0.5.0
```

Existing `^0.4.x` ranges do not select this release. The only behaviour change is that `drag()` releases one frame later; pass `settleFrames: 1` for the 0.4 timing.

## 0.4.1 — 2026-10-28

### Fixed

- `playwright-webxr/package.json` is now exported, so `require('playwright-webxr/package.json').version` (and the JSON import) can read the installed version. Up to 0.4.0 the `exports` map omitted it and both failed with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

### Upgrade

```sh
npm install -D playwright-webxr@^0.4.1
```

`^0.4.0` ranges already select this release. No API changes.

## 0.4.0 — 2026-10-28

### Added

- `hold(hand, button)` / `release(hand, button)` keep a button down across other calls.
- `drag(hand, { from, to, ms, steps, button, quaternion, toQuaternion, space, release })` hovers, grabs, moves along a path through intermediate XR frames and releases in one call.
- `setGripPose(hand, { position, quaternion })` and `controllerPose(hand)` place and read the profile grip instead of the target ray; `drag(..., { space: 'grip' })` moves the grip.
- `holdAxes(hand, x, y, { ms, frames })` and `flick(hand, direction)` for thumbstick timing.
- `disconnect(hand)` / `reconnect(hand)` for controller sleep and tracking loss.
- `haptics(hand)` returns haptic pulses requested by the app.
- `projectPoint(point, { eye })` returns NDC, frustum membership, canvas pixel, angle from the view centre and pixels per degree.

### Changed

- `pressButton()` now holds for at least `holdMs` **and** `frames` XR frames (default 2) and confirms the release in a later frame. Previously a press and release could both land between two frames on a slow page, and IWER then applied only the release. It now requires an active session (a press without one never reached the app).
- Controller input helpers reject unknown hands, button IDs and axes instead of silently doing nothing.
- When the runtime is missing because `xr` was first requested after navigation, helpers explain that and how to fix it.

### Upgrade

```sh
npm install -D playwright-webxr@^0.4.0
```

Existing `^0.3.0` dependency ranges do not select this release. `pressButton()` called without an active session now throws; such presses never reached the app before. Tests that wrote `__xrDevice` controller values directly can switch to `hold`/`release`/`drag`/`flick`/`disconnect`.

## 0.3.0 — 2026-09-13

### Added

- `endSession({ sessionId, timeout })` ends the active session and confirms both the `end()` promise and its `end` event. Missing/ended sessions and mismatched IDs fail without targeting a later session.
- `waitForFrames(count, { sessionId, timeout })` waits for successive XR animation frames on one session, with bounded waits and cancellation on exit. Application readiness assertions remain separate.
- A packaged, dependency-free controller-aiming example at `playwright-webxr/examples/aim-controller`, with tracking/world coordinate guidance and coverage through actual XR target-ray poses for both hands.
- Browser regressions for lifecycle races, failed/stalled exits, frame timeout cleanup and session isolation.

### Upgrade

```sh
npm install -D playwright-webxr@^0.3.0
```

Existing `^0.2.0` dependency ranges do not select this release. Existing APIs remain available. `endSession()` confirms XR session termination, not asynchronous application cleanup; `waitForFrames()` confirms XR frame progress, not application readiness.

## 0.2.0 — 2026-09-12

### Changed

- `enterVR()` now uses normal Playwright actionability checks, waits for a visible entry button, and confirms a newly granted live session. Errors distinguish missing/hidden buttons, failed clicks, rejected requests, and immediately ended sessions. Use `{ force: true }` only when intentionally bypassing actionability checks.
- External app integration tests are opt-in through `CAELUM_URL` and `STAGING_URL`; the default test suite is self-contained.

### Added

- Session IDs, request IDs, monotonic event sequences, `sessionCursor()`, and `waitForSessionEvent(event, { after, sessionId, timeout })` for entry/exit/re-entry checks. IDs and cursors are scoped to the current document and reset on navigation.
- `xrStereoEnabled` and `xrIpd` fixture options. Mono remains the default; stereo defaults to 0.064 m IPD. The app's canvas size is not changed automatically.
- `diagnostics()` reports runtime/browser versions, session state, layer configuration, per-eye base-layer viewports, input sources, canvas dimensions, and the selected canvas's existing GPU context. Unavailable information stays unknown with a reason.
- Screenshot canvas selection, bounded frame waits, and optional metadata containing pixel dimensions and session ID. The default return value remains the output path.
- 21 browser regression tests and GitHub Actions coverage for IWER 2.3.0 and 2.4.0.

### Fixed

- `sessionMode()` now uses the mode associated with the actual session request instead of relying on the nonstandard `XRSession.mode` property.
- Scoped lifecycle waits no longer confuse earlier sessions with a new entry or exit. The existing history-wide and numeric-timeout overloads remain supported.
- Runtime installation now loads IWER and initializes the fixture in a single ordered init script.
- The `settle(ms)` documentation now states that it waits elapsed time, without guaranteeing frame count or app readiness.

### Upgrade

```sh
npm install -D playwright-webxr@^0.2.0
```

Existing `^0.1.0` dependency ranges do not select this release. Review tests that depended on forced entry clicks. Canvas screenshots still do not prove composition-layer output or behavior on a physical headset.
