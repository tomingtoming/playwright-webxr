/**
 * Aim the controller's -Z target ray at a point in IWER tracking coordinates.
 * Both arrays are [x, y, z] in meters. Returns [x, y, z, w].
 * This chooses the shortest rotation from -Z; it does not preserve wrist roll.
 */
export function aimQuaternion(position, target) {
  for (const [name, value] of [['position', position], ['target', target]]) {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) {
      throw new Error(`${name} must be three finite coordinates`);
    }
  }
  const [dx, dy, dz] = target.map((value, i) => value - position[i]);
  const distance = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(distance) || distance === 0) {
    throw new Error('position and target must define a non-zero finite direction');
  }
  const radial = Math.hypot(dx, dy);
  if (radial === 0) return dz < 0 ? [0, 0, 0, 1] : [0, 1, 0, 0];
  // atan2 remains stable for nearly parallel and nearly opposite directions.
  const halfAngle = Math.atan2(radial, -dz) / 2;
  const sine = Math.sin(halfAngle);
  return [dy / radial * sine, -dx / radial * sine, 0, Math.cos(halfAngle)];
}
