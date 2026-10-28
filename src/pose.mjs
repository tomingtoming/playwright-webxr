// Small pose math for Node-side conversions. Quaternions are [x, y, z, w];
// 4x4 matrices are column-major arrays, as WebXR and gl-matrix use them.

export function quatMultiply(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatInvert([x, y, z, w]) {
  const n = x * x + y * y + z * z + w * w;
  return [-x / n, -y / n, -z / n, w / n];
}

export function rotateVector(q, v) {
  const [x, y, z] = quatMultiply(quatMultiply(q, [v[0], v[1], v[2], 0]), quatInvert(q));
  return [x, y, z];
}

export function quatFromMatrix(m) {
  // Rotation part of a column-major 4x4 matrix (assumed orthonormal).
  const m00 = m[0], m01 = m[4], m02 = m[8];
  const m10 = m[1], m11 = m[5], m12 = m[9];
  const m20 = m[2], m21 = m[6], m22 = m[10];
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
  const n = Math.hypot(...q);
  return q.map(c => c / n);
}

/** Compose parent * child, each { position, quaternion }. */
export function composePose(parent, child) {
  const offset = rotateVector(parent.quaternion, child.position);
  return {
    position: parent.position.map((c, i) => c + offset[i]),
    quaternion: quatMultiply(parent.quaternion, child.quaternion),
  };
}

export function invertPose({ position, quaternion }) {
  const inverse = quatInvert(quaternion);
  return { position: rotateVector(inverse, position).map(c => -c), quaternion: inverse };
}

export function poseFromMatrix(m) {
  return { position: [m[12], m[13], m[14]], quaternion: quatFromMatrix(m) };
}

export function transformPoint(m, [x, y, z]) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    w,
  ];
}
