// Små vektorhjälpare för trädgeneratorn (arrays [x, y, z], y uppåt)
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const UP = [0, 1, 0];

// Seedad PRNG (mulberry32)
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomUnit(r) {
  const z = r() * 2 - 1, phi = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(phi), z, s * Math.sin(phi)];
}

// Två vinkelräta enhetsvektorer till d
export function basis(d) {
  const ref = Math.abs(d[1]) < 0.95 ? UP : [1, 0, 0];
  const b1 = norm(cross(d, ref));
  return [b1, cross(d, b1)];
}
