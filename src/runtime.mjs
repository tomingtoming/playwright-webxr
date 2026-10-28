// This function is serialized into the page, after IWER in the same init script.
export function installRuntime({ deviceName, stereoEnabled, ipd, versions }) {
  const originalUserAgent = navigator.userAgent;
  const { XRDevice } = globalThis.IWER;
  const config = globalThis.IWER[deviceName];
  if (!config) throw new Error(`Unknown IWER device profile: ${deviceName}`);
  const device = new XRDevice(config);
  // Headless Chromium exposes a native stub; IWER must replace it.
  device.installRuntime({ forceInstall: true });
  device.stereoEnabled = stereoEnabled;
  device.ipd = ipd;
  globalThis.__xrDevice = device;

  const sessions = new WeakMap();
  const contexts = new WeakMap();
  const state = { sessions, contexts, versions, deviceName, originalUserAgent, sequence: 0 };
  globalThis.__pwWebXR = state;
  globalThis.__xrSessionLog = [];
  // Record haptic pulses per hand. vibrationActuator is hapticActuators[0], so
  // wrapping the instances covers both access paths.
  state.haptics = [];
  for (const hand of ['left', 'right']) {
    for (const [index, actuator] of (device.controllers?.[hand]?.inputSource.gamepad.hapticActuators ?? []).entries()) {
      const pulse = actuator.pulse.bind(actuator);
      actuator.pulse = (value, duration) => {
        state.haptics.push({ hand, actuator: index, value, duration, t: Math.floor(performance.now()) });
        return pulse(value, duration);
      };
    }
  }
  let requestId = 0;
  const log = (event, detail, request) => {
    globalThis.__xrSessionLog.push({
      event, detail: detail ?? null, t: Math.floor(performance.now()),
      sequence: ++state.sequence,
      requestId: request.requestId, sessionId: request.sessionId, mode: request.mode,
    });
  };

  // Observe only contexts requested by the app. Diagnostics must never create
  // a WebGL context on an unused canvas (which would lock its context type).
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...args) {
    const context = getContext.apply(this, args);
    if (context && ['webgl', 'webgl2', 'experimental-webgl'].includes(args[0])) {
      contexts.set(this, context);
    }
    return context;
  };

  const sys = navigator.xr;
  const requestSession = sys.requestSession.bind(sys);
  sys.requestSession = async (mode, init) => {
    const request = { requestId: ++requestId, sessionId: null, mode };
    log('request', mode, request);
    let session;
    try {
      session = await requestSession(mode, init);
    } catch (error) {
      log('rejected', String(error), request);
      throw error;
    }
    request.sessionId = `session-${request.requestId}`;
    const record = { ...request, ended: false };
    sessions.set(session, record);
    log('granted', mode, request);
    // Register before handing the session to the app, preserving the end probe.
    session.addEventListener('end', () => {
      record.ended = true;
      let detail = null;
      try {
        detail = globalThis.__xrEndProbe ? globalThis.__xrEndProbe() : null;
      } catch (error) {
        detail = 'probe threw: ' + error.message;
      }
      log('end', detail, request);
    }, { once: true });
    const end = session.end.bind(session);
    session.end = () => {
      log('end-called', String(new Error().stack).split('\n').slice(1, 5).join(' <- '), request);
      return end();
    };
    return session;
  };
}

// Runs in one page evaluation: select once before any asynchronous work so an
// exit/re-entry cannot redirect the operation to a different session.
export function runSessionOperation({ operation, sessionId, timeout, count }) {
  const device = globalThis.__xrDevice;
  const session = device?.activeSession;
  const record = session && globalThis.__pwWebXR?.sessions.get(session);
  if (!record || record.ended) {
    throw new Error(`${operation}: no active session${sessionId === undefined ? '' : ` (requested ${sessionId})`}`);
  }
  if (sessionId !== undefined && sessionId !== record.sessionId) {
    throw new Error(`${operation}: sessionId mismatch (requested ${sessionId}, active ${record.sessionId})`);
  }
  const id = record.sessionId;
  return new Promise((resolve, reject) => {
    let done = false;
    let frameId;
    let frames = 0;
    let endResolved = false;
    let endObserved = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.removeEventListener('end', onEnd);
      if (frameId !== undefined) session.cancelAnimationFrame(frameId);
      if (error) reject(new Error(`${operation}: ${id}: ${error}`));
      else resolve(operation === 'waitForFrames' ? { sessionId: id, frames } : { sessionId: id });
    };
    const onEnd = () => {
      if (operation === 'waitForFrames') {
        finish(`session ended after ${frames}/${count} XR frames`);
      } else {
        endObserved = true;
        if (endResolved) finish();
      }
    };
    const timer = setTimeout(() => finish(operation === 'waitForFrames'
      ? `timed out after ${timeout}ms waiting for XR frames (${frames}/${count})`
      : `timed out after ${timeout}ms waiting for end() and the end event`), timeout);
    session.addEventListener('end', onEnd, { once: true });

    if (operation === 'endSession') {
      // Install the listener first: IWER may dispatch end synchronously.
      // A fulfilled end() alone must not be mistaken for an observed end event.
      Promise.resolve().then(() => session.end()).then(() => {
        endResolved = true;
        if (endObserved) finish();
      }, error => finish(`end() failed: ${error?.message ?? String(error)}`));
      return;
    }

    if (count === 0) return finish();
    const requestFrame = () => {
      try {
        frameId = session.requestAnimationFrame(() => {
          frameId = undefined;
          if (done) return;
          if (record.ended || device.activeSession !== session) {
            return finish(`session ended or changed after ${frames}/${count} XR frames`);
          }
          frames++;
          if (frames === count) finish();
          else requestFrame();
        });
      } catch (error) {
        finish(`requestAnimationFrame() failed: ${error?.message ?? String(error)}`);
      }
    };
    requestFrame();
  });
}

// Runs in the page. Values come from the active render state and an XR frame,
// never from feature requests or from the mere presence of XRWebGLBinding.
export async function readDiagnostics({ canvas: selector, timeout }) {
  const state = globalThis.__pwWebXR;
  const device = globalThis.__xrDevice;
  const active = device?.activeSession;
  const record = active && state?.sessions.get(active);
  const session = record?.ended ? null : active;
  const snapshot = (views, viewsReason) => {
    const current = device?.activeSession;
    const record = current && state?.sessions.get(current);
    const session = record?.ended ? null : current;
    const canvas = document.querySelector(selector);
    const isCanvas = canvas instanceof HTMLCanvasElement;
    const renderState = session?.renderState;
    const baseLayer = renderState?.baseLayer;
    const layers = renderState?.layers;
    const layerType = (layer) => {
      for (const name of ['XRWebGLLayer', 'XRProjectionLayer', 'XRQuadLayer', 'XRCylinderLayer', 'XREquirectLayer', 'XRCubeLayer']) {
        if (typeof globalThis[name] === 'function' && layer instanceof globalThis[name]) return name;
      }
      return 'unknown';
    };
    const layerList = layers == null ? null : Array.from(layers, layer => ({ type: layerType(layer) }));
    const gl = isCanvas ? state?.contexts.get(canvas) : null;
    const gpu = { renderer: null, vendor: null, unmaskedRenderer: null, unmaskedVendor: null, reason: null };
    if (!gl) {
      gpu.reason = 'No observed WebGL context for the selected canvas';
    } else if (gl.isContextLost()) {
      gpu.reason = 'WebGL context is lost';
    } else {
      try {
        gpu.renderer = gl.getParameter(gl.RENDERER);
        gpu.vendor = gl.getParameter(gl.VENDOR);
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        if (debug) {
          gpu.unmaskedRenderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
          gpu.unmaskedVendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
        } else {
          gpu.reason = 'WEBGL_debug_renderer_info unavailable; renderer may be masked';
        }
      } catch (error) {
        gpu.reason = String(error);
      }
    }
    const result = {
      runtime: {
        installed: !!device,
        playwrightWebxrVersion: state?.versions.playwrightWebxr ?? null,
        iwerVersion: state?.versions.iwer ?? null,
        deviceProfile: state?.deviceName ?? null,
        stereoEnabled: device?.stereoEnabled ?? null,
        ipd: device?.ipd ?? null,
        userAgent: navigator.userAgent,
        originalUserAgent: state?.originalUserAgent ?? null,
      },
      session: session ? {
        id: record?.sessionId ?? null,
        mode: record?.mode ?? null,
        visibilityState: session.visibilityState ?? null,
        enabledFeatures: session.enabledFeatures == null ? null : Array.from(session.enabledFeatures),
        enabledFeaturesReason: session.enabledFeatures == null ? 'Runtime does not expose enabledFeatures' : null,
      } : null,
      rendering: {
        baseLayer: baseLayer ? {
          type: layerType(baseLayer),
          framebufferWidth: baseLayer.framebufferWidth ?? null,
          framebufferHeight: baseLayer.framebufferHeight ?? null,
        } : null,
        baseLayerReason: !session ? 'No active session' : !renderState ? 'Render state unavailable' : null,
        layers: layerList,
        layersReason: !session ? 'No active session' : layers == null ? 'Runtime does not expose renderState.layers' : null,
        projectionLayerCount: layerList == null || layerList.some(layer => layer.type === 'unknown')
          ? null : layerList.filter(layer => layer.type === 'XRProjectionLayer').length,
        projectionLayerCountReason: layerList == null ? 'Layer list unavailable'
          : layerList.some(layer => layer.type === 'unknown') ? 'One or more layer types cannot be identified' : null,
        canvas: isCanvas ? {
          selector, width: canvas.width, height: canvas.height,
          matchesBaseLayer: baseLayer?.context?.canvas ? baseLayer.context.canvas === canvas : null,
        } : null,
        canvasReason: !canvas ? `No canvas matches ${selector}` : !isCanvas ? `${selector} is not a canvas` : null,
        views,
        viewsReason,
      },
      inputSources: session ? Array.from(session.inputSources, input => ({
        handedness: input.handedness, targetRayMode: input.targetRayMode, profiles: Array.from(input.profiles),
      })) : null,
      gpu,
    };
    return result;
  };
  if (!session) return snapshot(null, 'No active session');

  // Bounded sampling: a granted session may have no frames, or end while the
  // reference space is being requested. Neither condition means zero views.
  const sample = await new Promise(resolve => {
    let done = false;
    let frameId;
    const finish = (views, reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.removeEventListener('end', onEnd);
      if (frameId !== undefined) session.cancelAnimationFrame(frameId);
      resolve({ views, reason });
    };
    const onEnd = () => finish(null, 'Session ended while sampling views');
    const timer = setTimeout(() => finish(null, 'Timed out waiting for an XR frame'), timeout);
    session.addEventListener('end', onEnd, { once: true });
    session.requestReferenceSpace('viewer').then(space => {
      if (done) return;
      frameId = session.requestAnimationFrame((_time, frame) => {
        try {
          const pose = frame.getViewerPose(space);
          if (!pose) return finish(null, 'Viewer pose unavailable');
          // Use this frame's layer, not a render state saved before the wait.
          const layer = session.renderState.baseLayer;
          const views = Array.from(pose.views, view => {
            const vp = layer?.getViewport(view);
            return {
              eye: view.eye,
              viewport: vp ? { x: vp.x, y: vp.y, width: vp.width, height: vp.height } : null,
              viewportReason: vp ? null : 'No base-layer viewport; projection subimages are not sampled',
            };
          });
          finish(views, null);
        } catch (error) {
          finish(null, String(error));
        }
      });
    }).catch(error => finish(null, String(error)));
  });
  if (device.activeSession !== session || record?.ended) {
    return snapshot(null, 'Session ended or changed while sampling views');
  }
  return snapshot(sample.views, sample.reason);
}

// Runs in one page evaluation. Input steps are applied from XR animation-frame
// callbacks, so a press, pose path or release cannot be lost between frames
// regardless of how slow the page or the test process is. IWER applies button
// values and controller poses at the start of the next frame; every value step
// is therefore followed by a frame wait by the caller.
export function runInputScript({ operation, steps, sessionId, timeout }) {
  const device = globalThis.__xrDevice;
  if (!device) throw new Error(`${operation}: IWER device missing`);
  const session = device.activeSession;
  const record = session && globalThis.__pwWebXR?.sessions.get(session);
  if (!record || record.ended) {
    throw new Error(`${operation}: no active session${sessionId === undefined ? '' : ` (requested ${sessionId})`}`);
  }
  if (sessionId !== undefined && sessionId !== record.sessionId) {
    throw new Error(`${operation}: sessionId mismatch (requested ${sessionId}, active ${record.sessionId})`);
  }
  const controller = hand => {
    const c = device.controllers?.[hand];
    if (!c) throw new Error(`${operation}: no ${hand} controller (expected 'left' or 'right')`);
    return c;
  };
  // IWER only warns on unknown IDs; a typo must fail the test instead.
  for (const step of steps) {
    if (step.hand !== undefined) controller(step.hand);
    if (step.type === 'button') {
      const ids = controller(step.hand).gamepadConfig.buttons.filter(Boolean).map(b => b.id);
      if (!ids.includes(step.button)) {
        throw new Error(`${operation}: ${step.hand} controller has no button '${step.button}' (has: ${ids.join(', ')})`);
      }
    }
    if (step.type === 'axes') {
      const ids = [...new Set(controller(step.hand).gamepadConfig.axes.filter(Boolean).map(a => a.id))];
      if (!ids.includes(step.axes)) {
        throw new Error(`${operation}: ${step.hand} controller has no axes '${step.axes}' (has: ${ids.join(', ')})`);
      }
    }
  }
  const slerp = (a, b, t) => {
    let [bx, by, bz, bw] = b;
    let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
    if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; }
    let s0 = 1 - t, s1 = t;
    if (dot < 0.9995) {
      const theta = Math.acos(dot), sin = Math.sin(theta);
      s0 = Math.sin((1 - t) * theta) / sin;
      s1 = Math.sin(t * theta) / sin;
    }
    const q = [s0 * a[0] + s1 * bx, s0 * a[1] + s1 * by, s0 * a[2] + s1 * bz, s0 * a[3] + s1 * bw];
    const n = Math.hypot(...q);
    return q.map(c => c / n);
  };
  const setPose = (hand, position, quaternion) => {
    const c = controller(hand);
    if (position) c.position.set(position[0], position[1], position[2]);
    if (quaternion) c.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  };

  const id = record.sessionId;
  return new Promise((resolve, reject) => {
    let done = false;
    let frameId;
    let index = 0;
    let wait = null;
    let frames = 0;
    const describe = () => `step ${index + 1}/${steps.length} (${steps[index]?.type ?? 'done'})`;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.removeEventListener('end', onEnd);
      if (frameId !== undefined) session.cancelAnimationFrame(frameId);
      if (error) reject(new Error(`${operation}: ${id}: ${error}`));
      else resolve({ sessionId: id, frames });
    };
    const onEnd = () => finish(`session ended at ${describe()} after ${frames} XR frames`);
    const timer = setTimeout(() => finish(`timed out after ${timeout}ms at ${describe()} after ${frames} XR frames`), timeout);
    session.addEventListener('end', onEnd, { once: true });

    const request = () => {
      try {
        frameId = session.requestAnimationFrame(() => {
          frameId = undefined;
          if (done) return;
          if (record.ended || device.activeSession !== session) {
            return finish(`session ended or changed at ${describe()}`);
          }
          frames++;
          if (wait) wait.frames++;
          advance();
        });
      } catch (error) {
        finish(`requestAnimationFrame() failed: ${error?.message ?? String(error)}`);
      }
    };
    const advance = () => {
      try {
        while (index < steps.length) {
          const step = steps[index];
          if (step.type === 'frames') {
            wait ??= { start: performance.now(), frames: 0 };
            if (wait.frames < step.count || performance.now() - wait.start < (step.minMs ?? 0)) return request();
          } else if (step.type === 'move') {
            wait ??= { start: performance.now(), frames: 0 };
            // Never faster than ms and never fewer than `steps` frames: a slow
            // page sees intermediate poses instead of a teleport.
            const byTime = step.ms > 0 ? (performance.now() - wait.start) / step.ms : 1;
            const t = Math.min(1, byTime, wait.frames / step.steps);
            setPose(step.hand,
              step.from.map((c, i) => c + (step.to[i] - c) * t),
              step.fromQuaternion && slerp(step.fromQuaternion, step.toQuaternion, t));
            if (t < 1) return request();
          } else if (step.type === 'button') {
            controller(step.hand).updateButtonValue(step.button, step.value);
          } else if (step.type === 'axes') {
            controller(step.hand).updateAxes(step.axes, step.x, step.y);
          } else if (step.type === 'pose') {
            setPose(step.hand, step.position, step.quaternion);
          } else if (step.type === 'connected') {
            controller(step.hand).connected = step.value;
          } else {
            throw new Error(`unknown step type ${step.type}`);
          }
          wait = null;
          index++;
        }
        finish();
      } catch (error) {
        finish(`${describe()} failed: ${error?.message ?? String(error)}`);
      }
    };
    advance();
  });
}

// Runs in the page: head pose, controller poses, profile grip offsets and one
// XR frame's viewer-relative views, all from the same moment.
export function readXRState({ timeout, views: sampleViews = true }) {
  const device = globalThis.__xrDevice;
  if (!device) throw new Error('IWER device missing');
  const deviceName = globalThis.__pwWebXR?.deviceName;
  const layout = globalThis.IWER?.[deviceName]?.controllerConfig?.layout ?? {};
  const vec = v => [v.x, v.y, v.z];
  const quat = q => [q.x, q.y, q.z, q.w];
  const controllers = {};
  for (const hand of ['left', 'right']) {
    const c = device.controllers?.[hand];
    if (!c) continue;
    controllers[hand] = {
      position: vec(c.position), quaternion: quat(c.quaternion), connected: c.connected,
      gripOffsetMatrix: layout[hand]?.gripOffsetMatrix ? Array.from(layout[hand].gripOffsetMatrix) : null,
    };
  }
  const base = { head: { position: vec(device.position), quaternion: quat(device.quaternion) }, controllers };
  if (!sampleViews) return { ...base, views: null, viewsReason: 'Views not requested' };
  const session = device.activeSession;
  const record = session && globalThis.__pwWebXR?.sessions.get(session);
  if (!session || record?.ended) return { ...base, views: null, viewsReason: 'No active session' };
  return new Promise(resolve => {
    let done = false;
    let frameId;
    const finish = (views, viewsReason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      session.removeEventListener('end', onEnd);
      if (frameId !== undefined) session.cancelAnimationFrame(frameId);
      // Head pose is read in the same frame as the views.
      resolve({ ...base, head: { position: vec(device.position), quaternion: quat(device.quaternion) }, views, viewsReason });
    };
    const onEnd = () => finish(null, 'Session ended while sampling views');
    const timer = setTimeout(() => finish(null, 'Timed out waiting for an XR frame'), timeout);
    session.addEventListener('end', onEnd, { once: true });
    session.requestReferenceSpace('viewer').then(space => {
      if (done) return;
      frameId = session.requestAnimationFrame((_time, frame) => {
        try {
          const pose = frame.getViewerPose(space);
          if (!pose) return finish(null, 'Viewer pose unavailable');
          const layer = session.renderState.baseLayer;
          const canvas = layer?.context?.canvas;
          finish(Array.from(pose.views, view => {
            const vp = layer?.getViewport(view);
            const { position: p, orientation: o } = view.transform;
            return {
              eye: view.eye,
              position: [p.x, p.y, p.z],
              quaternion: [o.x, o.y, o.z, o.w],
              projectionMatrix: Array.from(view.projectionMatrix),
              viewport: vp ? { x: vp.x, y: vp.y, width: vp.width, height: vp.height } : null,
              canvasHeight: canvas?.height ?? null,
            };
          }), null);
        } catch (error) {
          finish(null, String(error));
        }
      });
    }).catch(error => finish(null, String(error)));
  });
}
