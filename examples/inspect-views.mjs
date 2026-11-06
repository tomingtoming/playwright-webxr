/**
 * Photograph one 3D target from several named viewpoints.
 * Dependency-free apart from the `xr` fixture you pass in. Copy it if you need changes.
 *
 * Conventions: IWER tracking coordinates in metres; quaternions are [x, y, z, w].
 * With the default up [0, 1, 0] and front [0, 0, 1]:
 *   yaw > 0   moves the camera towards +X (radians, around up)
 *   pitch > 0 moves the camera above the target (radians)
 *   roll > 0  turns the head counter-clockwise around its own +Z, like the third
 *             value of setHeadPose({ euler }); the image then appears rotated clockwise
 */
const check = (value, name, length = 3) => {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new Error(`${name} must be ${length} finite numbers`);
  }
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, s) => a.map(c => c * s);
const add = (a, b) => a.map((c, i) => c + b[i]);
const normalize = (a, name) => {
  const length = Math.hypot(...a);
  if (length < 1e-9) throw new Error(`${name} has no usable direction`);
  return scale(a, 1 / length);
};
const multiply = ([ax, ay, az, aw], [bx, by, bz, bw]) => [
  aw * bx + ax * bw + ay * bz - az * by,
  aw * by - ax * bz + ay * bw + az * bx,
  aw * bz + ax * by - ay * bx + az * bw,
  aw * bw - ax * bx - ay * by - az * bz,
];
const rotate = (q, v) => {
  const [x, y, z] = multiply(multiply(q, [...v, 0]), [-q[0], -q[1], -q[2], q[3]]);
  return [x, y, z];
};
// Columns are the head's +X, +Y and +Z axes in tracking space.
const fromBasis = ([m00, m10, m20], [m01, m11, m21], [m02, m12, m22]) => {
  const trace = m00 + m11 + m22;
  let q;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s, 0.25 / s];
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  return normalize(q, 'orientation');
};

/**
 * A head pose looking at target from `distance`, for setHeadPose().
 * Unlike aimQuaternion(), which picks the shortest rotation and leaves roll
 * undefined, this keeps the head upright against an explicit up direction.
 */
export function lookAtHeadPose({ target, distance, yaw = 0, pitch = 0, roll = 0, up = [0, 1, 0], front = [0, 0, 1] }) {
  check(target, 'target');
  check(up, 'up');
  check(front, 'front');
  if (!Number.isFinite(distance) || distance <= 0) throw new Error('distance must be a positive number of metres');
  for (const [name, value] of [['yaw', yaw], ['pitch', pitch], ['roll', roll]]) {
    if (!Number.isFinite(value)) throw new Error(`${name} must be finite radians`);
  }
  const u = normalize(up, 'up');
  const f = normalize(add(front, scale(u, -dot(front, u))), 'front (parallel to up)');
  const r = cross(u, f);
  const horizontal = add(scale(f, Math.cos(yaw)), scale(r, Math.sin(yaw)));
  const back = normalize(add(scale(horizontal, Math.cos(pitch)), scale(u, Math.sin(pitch))), 'view direction');
  const x = normalize(cross(u, back), 'view direction (parallel to up)');
  const y = cross(back, x);
  const q = multiply(fromBasis(x, y, back), [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)]);
  return { position: add(target, scale(back, distance)), quaternion: q };
}

/**
 * Capture each view, then restore the starting head pose, even on failure.
 *
 * views: [{ name, target, distance, yaw?, pitch?, roll?, up?, front? }]
 *   name becomes <name>.png and <name>.json, attached to the report.
 * worldToTracking: { position, quaternion }, optional. Maps your scene into
 *   tracking space (the inverse of your rig's tracking-to-world transform); target,
 *   up and front are then given in scene coordinates. Rigid only, no scale.
 * ready: optional async ({ name, pose }) => {}. Assert app readiness here. XR frames
 *   alone do not prove assets, hover state or simulation have settled.
 */
export async function captureViews(xr, testInfo, views, { worldToTracking, ready, frames = 2, canvas, device, timeout } = {}) {
  if (!Array.isArray(views) || views.length === 0) throw new Error('views must be a non-empty array');
  const names = views.map(view => view.name);
  if (new Set(names).size !== names.length) throw new Error(`view names must be unique: ${names.join(', ')}`);
  const toTracking = view => {
    if (!worldToTracking) return view;
    const { position, quaternion } = worldToTracking;
    return {
      ...view,
      target: add(rotate(quaternion, view.target), position),
      up: rotate(quaternion, view.up ?? [0, 1, 0]),
      front: rotate(quaternion, view.front ?? [0, 0, 1]),
    };
  };
  // Validate every pose first, so a bad view fails before anything moves.
  const posed = views.map(view => ({ name: view.name, pose: lookAtHeadPose(toTracking(view)) }));
  const start = await xr.headPose();
  const results = {};
  try {
    for (const { name, pose } of posed) {
      await xr.setHeadPose(pose);
      await xr.waitForFrames(frames);
      if (ready) await ready({ name, pose });
      const options = { ...(canvas && { canvas }), ...(device && { device }), ...(timeout && { timeout }) };
      results[name] = { pose, capture: await xr.attachCapture(testInfo, name, options) };
    }
  } finally {
    await xr.setHeadPose(start);
    if (await xr.sessionMode()) await xr.waitForFrames(1);
  }
  return results;
}
