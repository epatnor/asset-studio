// Terrängens rutnät (docs/terrain.md, T1): marken som ett rutnät i världen med höjden ur en funktion. Ren JavaScript
// utan Three.js, så att samma kod körs i studion och i kontrollerna i Node (tools/terrain/check_terrain.mjs).
//
// Tre saker skiljer det från ett vanligt PlaneGeometry med höjder:
// - Diagonalerna följer höjdkurvorna: varje ruta delas längs den diagonal vars mittpunkt ligger närmast den riktiga
//   höjden mitt i rutan. Med samma diagonal överallt blir en böjd strandlinje en sågtand.
// - Normalerna räknas ur höjdfunktionen (centrala differenser), inte ur trianglarna, så ljuset blir mjukt även där
//   rutnätet glesnar.
// - sample(x, z) interpolerar exakt som trianglarna ritas, så det som ställs på marken står på den och inte i den.
//
//   const f = buildField(axis(-90, 90, -30, 30, 0.3), axis(-120, 120, -50, 40, 0.3), heightAt);
//   geometry.setAttribute('position', new THREE.BufferAttribute(f.positions, 3));
//   geometry.setAttribute('normal', new THREE.BufferAttribute(f.normals, 3));
//   geometry.setIndex(new THREE.BufferAttribute(f.index, 1));

// Koordinater längs en axel: tätt i [fineMin, fineMax], allt glesare utanför (växer med growth per steg)
export function axis(min, max, fineMin, fineMax, step, growth = 1.07) {
  const xs = [];
  for (let x = fineMin; x <= fineMax + 1e-6; x += step) xs.push(x);
  for (let s = step, x = fineMin; x > min;) { s *= growth; x = Math.max(min, x - s); xs.unshift(x); }
  for (let s = step, x = xs[xs.length - 1]; x < max;) { s *= growth; x = Math.min(max, x + s); xs.push(x); }
  return xs;
}

// Index för rutan som innehåller v (binärsökning; utanför kanten blir det kantrutan)
function cellOf(a, v) {
  let lo = 0, hi = a.length - 2;
  if (v <= a[0]) return 0;
  if (v >= a[hi + 1]) return hi;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= v) lo = m; else hi = m - 1; }
  return lo;
}

// xs × zs med höjden ur heightAt(x, z). byDifference: för höjder ur ett rutnät med samma täthet (generatorn), där
// mitten bara är medelvärdet av hörnen; då delas rutan längs diagonalen med minst höjdskillnad (följer dalar och åsar)
export function buildField(xs, zs, heightAt, { byDifference = false } = {}) {
  const nx = xs.length, nz = zs.length, n = nx * nz;
  const heights = new Float32Array(n), positions = new Float32Array(n * 3), normals = new Float32Array(n * 3);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = xs[i], z = zs[j], h = heightAt(x, z);
    heights[k] = h;
    positions.set([x, h, z], k * 3);
    // Normalen ur funktionen, med ett steg som följer rutnätets täthet (halva den minsta grannrutan)
    const ex = 0.5 * Math.min(xs[Math.min(i + 1, nx - 1)] - x || Infinity, x - xs[Math.max(i - 1, 0)] || Infinity);
    const ez = 0.5 * Math.min(zs[Math.min(j + 1, nz - 1)] - z || Infinity, z - zs[Math.max(j - 1, 0)] || Infinity);
    const gx = (heightAt(x + ex, z) - heightAt(x - ex, z)) / (2 * ex), gz = (heightAt(x, z + ez) - heightAt(x, z - ez)) / (2 * ez);
    const l = Math.hypot(gx, 1, gz);
    normals.set([-gx / l, 1 / l, -gz / l], k * 3);
  }
  // Diagonalen per ruta: 1 = a–d, 0 = b–c (a = (i, j), b = (i+1, j), c = (i, j+1), d = (i+1, j+1))
  const diag = new Uint8Array((nx - 1) * (nz - 1)), index = new Uint32Array((nx - 1) * (nz - 1) * 6);
  for (let j = 0, q = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++, q++) {
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    let ad;
    if (byDifference) ad = Math.abs(heights[a] - heights[d]) < Math.abs(heights[b] - heights[c]);
    else {
      const mid = heightAt((xs[i] + xs[i + 1]) / 2, (zs[j] + zs[j + 1]) / 2);
      ad = Math.abs((heights[a] + heights[d]) / 2 - mid) < Math.abs((heights[b] + heights[c]) / 2 - mid);
    }
    diag[q] = ad ? 1 : 0;
    index.set(ad ? [a, c, d, a, d, b] : [a, c, b, b, c, d], q * 6);
  }
  // Höjden i (x, z) på trianglarna, som de ritas
  function sample(x, z) {
    const i = cellOf(xs, x), j = cellOf(zs, z);
    const fx = Math.min(1, Math.max(0, (x - xs[i]) / (xs[i + 1] - xs[i]))), fz = Math.min(1, Math.max(0, (z - zs[j]) / (zs[j + 1] - zs[j])));
    const a = heights[j * nx + i], b = heights[j * nx + i + 1], c = heights[(j + 1) * nx + i], d = heights[(j + 1) * nx + i + 1];
    if (diag[j * (nx - 1) + i]) return fx >= fz ? a + (b - a) * fx + (d - b) * fz : a + (c - a) * fz + (d - c) * fx;
    return fx + fz <= 1 ? a + (b - a) * fx + (c - a) * fz : d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }
  return { xs, zs, nx, nz, count: n, heights, positions, normals, index, diag, sample };
}
