# Changelog

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
