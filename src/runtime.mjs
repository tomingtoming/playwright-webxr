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
