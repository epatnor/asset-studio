// Vågornas gångtid från stranden (eikonalfältet) för de brytande vågorna i water.js. Efter shoreMap.js i Ultra-Water
// (github.com/Humpalumps/Ultra-Water, MIT, © 2026 Humpalumps): tiden τ (s) som en våg på grunt vatten behöver från
// strandlinjen hit, |∇τ| = 1/c med c = √(g·djup), löst med "fast sweeping" (Gauss–Seidel i fyra riktningar) på båda
// sidor om strandlinjen och negativ på land, så att τ är jämn över vattenlinjen. Vågornas fas är ω(τ + t): fronterna
// saktar in, packas tätare och böjer sig efter botten på väg in. Ur τ fås också riktningen in mot land (−∇τ) och hur
// samstämmig fronten är (1 på rena fronter, mot 0 där fronter från två strandsträckor möts; där tonas vågorna ut).
// Ultra-Waters strålrör (ray-tube) för uddar och vikar är inte med.
//
// Dessutom kustkartan (s.coast) för skummet vid branta kanter: avståndet till land i meter (R, 0..COAST_MAX) och hur
// brant kusten är (G: djupt nära land, som vid klippor, stenar och kajer), även runt små holmar.
//
//   const s = travelField(bedAt, level, x0, x1, z0, z1);  s.at(x, z) → [τ, riktning x, riktning z, samstämmighet]
//   s.coast → { data (RGBA8, nx × nz), x0, z0, h }
//
// Utan någon vattenlinje i rutan är s null.
const GRAV = 9.81, DMIN = 0.3, DMAX = 14;
export const COAST_MAX = 24;
const ISLET = 24; // landfläckar mindre än så (rutor) ger inga egna fronter: de bryter de förbipasserande i stället

export function travelField(bedAt, level, x0, x1, z0, z1, maxCells = 384) {
  const h = Math.max(0.5, Math.max(x1 - x0, z1 - z0) / maxCells);
  const nx = Math.max(2, Math.ceil((x1 - x0) / h) + 1), nz = Math.max(2, Math.ceil((z1 - z0) / h) + 1), n = nx * nz;
  const height = new Float32Array(n), sea = new Uint8Array(n);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, y = bedAt(x0 + i * h, z0 + j * h) - level;
    height[k] = y; sea[k] = y < 0 ? 1 : 0;
  }
  const coast = coastMap(height, sea, nx, nz, h);
  if (!coast) return null;
  coast.x0 = x0; coast.z0 = z0; coast.h = h;
  const still = { h, nx, nz, at: () => [0, 0, 0, 0], coast }; // bara holmar: inga vågfronter, men kustkartan
  const wet = wetMask(sea, nx, nz);
  let any = false;
  for (let k = 0; k < n && !any; k++) if (!wet[k]) any = true;
  if (!any) return still;
  const c = new Float32Array(n), slow = new Float64Array(n);
  for (let k = 0; k < n; k++) { c[k] = Math.sqrt(GRAV * Math.min(DMAX, Math.max(DMIN, -height[k]))); slow[k] = h / c[k]; }
  const W = nx + 2, T = new Float64Array(W * (nz + 2)).fill(Infinity), open = new Uint8Array(W * (nz + 2));
  if (!seed(T, open, height, wet, slow, nx, nz)) return still;
  for (let it = 0; it < 40; it++) if (!sweep(T, open, slow, nx, nz)) break;
  // τ med tecken: positiv ute i vattnet, negativ på land
  const tau = new Float32Array(n);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, t = T[(j + 1) * W + i + 1];
    tau[k] = t === Infinity ? NaN : wet[k] ? t : -t;
  }
  // Riktningen −∇τ/|∇τ| och samstämmigheten |∇τ|·c (nära 1 på rena fronter, faller där fronter möts)
  const dx = new Float32Array(n), dz = new Float32Array(n), coh = new Float32Array(n);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    if (Number.isNaN(tau[k])) continue;
    const l = tau[k - (i > 0)], r = tau[k + (i < nx - 1)], d = tau[k - (j > 0) * nx], u = tau[k + (j < nz - 1) * nx];
    if ([l, r, d, u].some(Number.isNaN)) continue;
    const gx = (r - l) / (h * ((i > 0) + (i < nx - 1))), gz = (u - d) / (h * ((j > 0) + (j < nz - 1))), g = Math.hypot(gx, gz);
    if (g < 1e-9) continue;
    dx[k] = -gx / g; dz[k] = -gz / g;
    const q = Math.min(1, Math.max(0, (g * c[k] - 0.7) / 0.25));
    coh[k] = q * q * (3 - 2 * q);
  }
  blur(coh, nx, nz, 2); // mjuk övergång in mot chockerna
  return {
    h, nx, nz, coast,
    at(x, z) {
      const gx = Math.min(nx - 1.001, Math.max(0, (x - x0) / h)), gz = Math.min(nz - 1.001, Math.max(0, (z - z0) / h));
      const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j, k = j * nx + i;
      const ks = [k, k + 1, k + nx, k + nx + 1], ws = [(1 - fx) * (1 - fz), fx * (1 - fz), (1 - fx) * fz, fx * fz];
      let t = 0, a = 0, b = 0, q = 0, wsum = 0;
      for (let m = 0; m < 4; m++) {
        if (Number.isNaN(tau[ks[m]])) continue;
        t += tau[ks[m]] * ws[m]; a += dx[ks[m]] * ws[m]; b += dz[ks[m]] * ws[m]; q += coh[ks[m]] * ws[m]; wsum += ws[m];
      }
      if (wsum < 1e-6) return [0, 0, 0, 0];
      const len = Math.hypot(a, b) || 1;
      return [t / wsum, a / len, b / len, q / wsum];
    },
  };
}

// Kustkartan: avståndet till vattenlinjen (samma lösare med farten 1, så att tiden blir meter) och brantheten: djupet
// delat med avståndet till land nära kusten (en flack strand ≈ 0,05, en klippa > 1), utsträckt och utjämnad lite
function coastMap(height, sea, nx, nz, h) {
  const n = nx * nz, W = nx + 2, unit = new Float64Array(n).fill(h);
  const T = new Float64Array(W * (nz + 2)).fill(Infinity), open = new Uint8Array(W * (nz + 2));
  if (!seed(T, open, height, sea, unit, nx, nz)) return null;
  for (let it = 0; it < 40; it++) if (!sweep(T, open, unit, nx, nz)) break;
  const dist = new Float32Array(n), steep = new Float32Array(n);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, d = T[(j + 1) * W + i + 1];
    dist[k] = d;
    if (sea[k] && d < 16) steep[k] = smooth(0.25, 0.8, -height[k] / Math.max(d, h * 0.5));
  }
  dilate(steep, nx, nz, 2);
  blur(steep, nx, nz, 2);
  const data = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    data[k * 4] = Math.round(255 * Math.min(1, dist[k] / COAST_MAX));
    data[k * 4 + 1] = Math.round(255 * Math.min(1, steep[k]));
    data[k * 4 + 3] = 255;
  }
  return { data, nx, nz };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Havet med små holmar översvämmade: de skulle annars få egna ringar av vågkammar
function wetMask(sea, nx, nz) {
  const n = nx * nz, wet = sea.slice(), seen = new Uint8Array(n), stack = new Int32Array(n), comp = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (sea[s] || seen[s]) continue;
    let top = 0, cnt = 0;
    stack[top++] = s; seen[s] = 1;
    while (top > 0) {
      const k = stack[--top], i = k % nx;
      comp[cnt++] = k;
      for (const m of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) if (m >= 0 && m < n && !sea[m] && !seen[m]) { seen[m] = 1; stack[top++] = m; }
    }
    if (cnt < ISLET) for (let q = 0; q < cnt; q++) wet[comp[q]] = 1;
  }
  return wet;
}

// Fröna: rutor med en granne på andra sidan vattenlinjen får avståndet dit (där höjden går genom 0) i tid; de är låsta
// (open = 2). open = 1: räkna om, 0: klar. T och open har en ram på en ruta, så att grannarna inte behöver kontrolleras
function seed(T, open, height, wet, slow, nx, nz) {
  const W = nx + 2;
  open.fill(2);
  for (let j = 0; j < nz; j++) open.fill(1, (j + 1) * W + 1, (j + 1) * W + 1 + nx);
  let seeds = 0;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, w = wet[k], y = height[k];
    let dx = Infinity, dy = Infinity;
    const cross = (m) => Math.min(1, Math.abs(y / (y - height[m] || 1e-6)));
    if (i > 0 && wet[k - 1] !== w) dx = cross(k - 1);
    if (i < nx - 1 && wet[k + 1] !== w) dx = Math.min(dx, cross(k + 1));
    if (j > 0 && wet[k - nx] !== w) dy = cross(k - nx);
    if (j < nz - 1 && wet[k + nx] !== w) dy = Math.min(dy, cross(k + nx));
    if (dx === Infinity && dy === Infinity) continue;
    const d = dx === Infinity ? dy : dy === Infinity ? dx : dx * dy / (Math.hypot(dx, dy) || 1);
    const p = (j + 1) * W + i + 1;
    T[p] = d * slow[k]; open[p] = 2; seeds++;
  }
  return seeds > 0;
}

function pass(T, open, slow, nx, nz, di, dj) {
  const W = nx + 2;
  let changed = 0;
  for (let jj = 0, j = dj > 0 ? 0 : nz - 1; jj < nz; jj++, j += dj) {
    for (let ii = 0, i = di > 0 ? 0 : nx - 1; ii < nx; ii++, i += di) {
      const p = (j + 1) * W + i + 1;
      if (open[p] !== 1) continue;
      open[p] = 0;
      const l = T[p - 1], r = T[p + 1], u = T[p - W], v = T[p + W];
      const a = l < r ? l : r, b = u < v ? u : v, f = slow[j * nx + i], d = a > b ? a - b : b - a;
      const t = d >= f ? (a < b ? a : b) + f : 0.5 * (a + b + Math.sqrt(2 * f * f - d * d));
      if (t < T[p] - 1e-4) {
        T[p] = t; changed++;
        if (open[p - 1] === 0) open[p - 1] = 1;
        if (open[p + 1] === 0) open[p + 1] = 1;
        if (open[p - W] === 0) open[p - W] = 1;
        if (open[p + W] === 0) open[p + W] = 1;
      }
    }
  }
  return changed;
}
const sweep = (T, open, slow, nx, nz) =>
  pass(T, open, slow, nx, nz, 1, 1) + pass(T, open, slow, nx, nz, -1, 1) + pass(T, open, slow, nx, nz, 1, -1) + pass(T, open, slow, nx, nz, -1, -1);

function dilate(a, nx, nz, r) {
  const tmp = new Float32Array(a.length);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let m = 0;
    for (let q = Math.max(0, i - r); q <= Math.min(nx - 1, i + r); q++) m = Math.max(m, a[j * nx + q]);
    tmp[j * nx + i] = m;
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let m = 0;
    for (let q = Math.max(0, j - r); q <= Math.min(nz - 1, j + r); q++) m = Math.max(m, tmp[q * nx + i]);
    a[j * nx + i] = m;
  }
}

function blur(a, nx, nz, r) {
  const tmp = new Float32Array(a.length);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let s = 0, w = 0;
    for (let q = -r; q <= r; q++) { const ii = i + q; if (ii >= 0 && ii < nx) { s += a[j * nx + ii]; w++; } }
    tmp[j * nx + i] = s / w;
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let s = 0, w = 0;
    for (let q = -r; q <= r; q++) { const jj = j + q; if (jj >= 0 && jj < nz) { s += tmp[jj * nx + i]; w++; } }
    a[j * nx + i] = s / w;
  }
}
