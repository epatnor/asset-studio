// Tygsimulering (docs/effektlabb.md, Flaggan): implicit integration efter Baraff och Witkin, "Large Steps in Cloth
// Simulation" (SIGGRAPH 98), portad från Thom Chiovolonis tygdemo (MIT, licensen nedan). Partiklar i ett rutnät med
// fjädrar för sträckning, skjuvning och böjning, med dämpning och derivator (dF/dX, dF/dV), så att varje steg löser
// (M - dt·dF/dV - dt²·dF/dX) · dV = dt·(F + dt·dF/dX·V) med en filtrerad konjugerad gradient; fästa partiklar filtreras
// bort. Det tål mycket styva fjädrar och stora steg: tyget töjs inte och exploderar inte.
//
// Tillägg här: riktig massa per partikel; vinden ur vårt vindfält (windAt) med tryck längs normalen (luftmotstånd)
// och friktion längs tyget, så att en flagga flyger ut vågrätt i stället för att lyftas av en konstgjord uppåtvind;
// luftmotståndet ingår i dF/dV för stabilitet; stångkanten fäst; musgreppet som en flyttad fästpunkt.
// Ren JS utan three.js (kan provas i Node). Allt i världens koordinater (meter, y uppåt).
//
//   const cloth = createCloth({ width, height, anchor: [x, y, z], dir: [dx, dz] });
//   cloth.step(dt, (x, y, z) => [vx, vy, vz])   // vindens hastighet (m/s) i en punkt
//   cloth.positions, cloth.normals, cloth.uvs, cloth.indices
//   cloth.grab(i, [x, y, z]) / cloth.grab(i, null), cloth.nearest([x, y, z])
//
// The MIT License (MIT)
//
// Copyright (c) 2016-2019 Thom Chiovoloni
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

export const CLOTH_DEFAULTS = {
  nx: 22, ny: 14, // partiklar längs flaggan och nedåt
  density: 0.2, // kg per m² (bomullsflagga)
  // Fjädrarnas styvhet (N/m): stum i sträckning, mjuk i skjuvning och böjning, så att tyget kan vecka sig och hänga
  // (avståndsfjädrar över två celler stretar annars emot även när tyget trycks ihop i sitt plan)
  structK: 3000, shearK: 1, bendK: 0.02,
  dampSpring: 0.2, // fjädrarnas dämpning (N·s/m)
  airNormal: 0.75, // luftmotstånd längs normalen: ½ρ·Cd (kg/m³), kraft = airNormal·(v·n)|v·n|·A
  airTangent: 0.05, // friktion längs tyget: kraft = airTangent·|v|·v_t·A
  timeStep: 1 / 60, maxSteps: 3, gravity: -9.81, cgIterations: 30, cgEpsilon: 0.02,
};

export function createCloth(opts) {
  const o = { ...CLOTH_DEFAULTS, ...opts };
  const { nx, ny } = o, n = nx * ny, n3 = n * 3;
  const dx = o.width / (nx - 1), dy = o.height / (ny - 1);
  const X = new Float64Array(n3), V = new Float64Array(n3), F = new Float64Array(n3), N = new Float64Array(n3);
  const uvs = new Float32Array(n * 2), positions = new Float32Array(n3), normals = new Float32Array(n3);
  const pinned = new Uint8Array(n), pin = new Float64Array(n3), area = new Float64Array(n);
  const dl = Math.hypot(o.dir?.[0] ?? 1, o.dir?.[1] ?? 0) || 1, ux = (o.dir?.[0] ?? 1) / dl, uz = (o.dir?.[1] ?? 0) / dl;
  const [ax, ay, az] = o.anchor;
  const idx = (i, j) => i * nx + j; // i nedåt (rad), j ut från stången (kolumn)
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    const k = idx(i, j);
    X[k * 3] = ax + ux * j * dx; X[k * 3 + 1] = ay - i * dy; X[k * 3 + 2] = az + uz * j * dx;
    uvs[k * 2] = j / (nx - 1); uvs[k * 2 + 1] = 1 - i / (ny - 1);
    area[k] = dx * dy * (j === 0 || j === nx - 1 ? 0.5 : 1) * (i === 0 || i === ny - 1 ? 0.5 : 1);
    if (j === 0) { pinned[k] = 1; pin.set(X.subarray(k * 3, k * 3 + 3), k * 3); } // stångkanten sitter fast
  }
  const mass = Float64Array.from(area, (a) => a * o.density);
  // Fjädrar: a, b, vilolängd, k; varje fjäder har två block utanför diagonalen i de glesa matriserna
  const springs = [];
  const add = (a, b, k) => springs.push({ a, b, k, rest: Math.hypot(X[b * 3] - X[a * 3], X[b * 3 + 1] - X[a * 3 + 1], X[b * 3 + 2] - X[a * 3 + 2]) });
  for (let i = 0; i < ny; i++) for (let j = 0; j < nx; j++) {
    if (i + 1 < ny) add(idx(i, j), idx(i + 1, j), o.structK);
    if (j + 1 < nx) add(idx(i, j), idx(i, j + 1), o.structK);
    if (i + 1 < ny && j + 1 < nx) add(idx(i, j), idx(i + 1, j + 1), o.shearK);
    if (i + 1 < ny && j > 0) add(idx(i, j), idx(i + 1, j - 1), o.shearK);
    if (i + 2 < ny) add(idx(i, j), idx(i + 2, j), o.bendK);
    if (j + 2 < nx) add(idx(i, j), idx(i, j + 2), o.bendK);
  }
  const indices = [];
  for (let i = 0; i < ny - 1; i++) for (let j = 0; j < nx - 1; j++) {
    const v0 = idx(i, j), v1 = idx(i, j + 1), v2 = idx(i + 1, j + 1), v3 = idx(i + 1, j);
    indices.push(v0, v3, v1, v1, v3, v2);
  }
  // Glesa block-matriser: n diagonalblock följt av två block per fjäder (ab, ba); rad och kolumn per block
  const B = n + springs.length * 2;
  const rows = new Int32Array(B), cols = new Int32Array(B);
  for (let k = 0; k < n; k++) { rows[k] = cols[k] = k; }
  springs.forEach((s, m) => { const p = n + m * 2; rows[p] = s.a; cols[p] = s.b; rows[p + 1] = s.b; cols[p + 1] = s.a; s.iab = p; s.iba = p + 1; });
  const dFdX = new Float64Array(B * 9), dFdV = new Float64Array(B * 9), A = new Float64Array(B * 9);
  const dV = new Float64Array(n3), b = new Float64Array(n3), tmp = new Float64Array(n3);
  const r = new Float64Array(n3), d = new Float64Array(n3), q = new Float64Array(n3);
  let grabbed = -1;
  const grabAt = new Float64Array(3);
  const fixed = (k) => pinned[k] || k === grabbed;

  function mulM(out, M, v) { // out = M · v (blocken som kolumn-rad, som i originalet)
    out.fill(0);
    for (let p = 0; p < B; p++) {
      const m = p * 9, vr = rows[p] * 3, vc = cols[p] * 3;
      const x = v[vr], y = v[vr + 1], z = v[vr + 2];
      out[vc] += x * M[m] + y * M[m + 3] + z * M[m + 6];
      out[vc + 1] += x * M[m + 1] + y * M[m + 4] + z * M[m + 7];
      out[vc + 2] += x * M[m + 2] + y * M[m + 5] + z * M[m + 8];
    }
    return out;
  }
  const filter = (v) => { for (let k = 0; k < n; k++) if (fixed(k)) { v[k * 3] = 0; v[k * 3 + 1] = 0; v[k * 3 + 2] = 0; } };
  const dot = (a, c) => { let s = 0; for (let i = 0; i < n3; i++) s += a[i] * c[i]; return s; };

  function calcNormals() {
    N.fill(0);
    for (let t = 0; t < indices.length; t += 3) {
      const a = indices[t] * 3, c = indices[t + 1] * 3, e = indices[t + 2] * 3;
      const ux1 = X[c] - X[a], uy1 = X[c + 1] - X[a + 1], uz1 = X[c + 2] - X[a + 2];
      const vx1 = X[e] - X[c], vy1 = X[e + 1] - X[c + 1], vz1 = X[e + 2] - X[c + 2];
      const fx = uy1 * vz1 - uz1 * vy1, fy = uz1 * vx1 - ux1 * vz1, fz = ux1 * vy1 - uy1 * vx1;
      for (const p of [a, c, e]) { N[p] += fx; N[p + 1] += fy; N[p + 2] += fz; }
    }
    for (let k = 0; k < n3; k += 3) { const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1; N[k] /= l; N[k + 1] /= l; N[k + 2] /= l; }
  }

  function calcForces(windAt) {
    calcNormals();
    dFdX.fill(0); dFdV.fill(0);
    for (let k = 0; k < n; k++) {
      const i = k * 3, m = k * 9;
      F[i] = 0; F[i + 1] = o.gravity * mass[k]; F[i + 2] = 0;
      // Vinden: relativ vind w - v; tryck längs normalen (kvadratiskt) och friktion längs tyget
      const w = windAt(X[i], X[i + 1], X[i + 2]);
      const rx = w[0] - V[i], ry = w[1] - V[i + 1], rz = w[2] - V[i + 2];
      const nxx = N[i], nyy = N[i + 1], nzz = N[i + 2];
      const rn = rx * nxx + ry * nyy + rz * nzz, rl = Math.hypot(rx, ry, rz);
      const tx = rx - nxx * rn, ty = ry - nyy * rn, tz = rz - nzz * rn;
      const cn = o.airNormal * Math.abs(rn) * area[k], ct = o.airTangent * rl * area[k];
      F[i] += nxx * rn * cn + tx * ct; F[i + 1] += nyy * rn * cn + ty * ct; F[i + 2] += nzz * rn * cn + tz * ct;
      // dF/dV för luften (linjäriserad): -cn·n nᵀ - ct·(I - n nᵀ), dämpar och stabiliserar
      const nn = [nxx, nyy, nzz];
      for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) {
        const nac = nn[a] * nn[c];
        dFdV[m + a * 3 + c] -= cn * 2 * nac + ct * ((a === c ? 1 : 0) - nac);
      }
    }
    for (const s of springs) spring(s);
  }

  // En fjäder: kraft och derivator (som preSolveSpring i originalet)
  function spring(s) {
    const sa = s.a * 3, sb = s.b * 3, k = s.k, rest = s.rest, damp = o.dampSpring;
    const eX = X[sb] - X[sa], eY = X[sb + 1] - X[sa + 1], eZ = X[sb + 2] - X[sa + 2];
    const length = Math.hypot(eX, eY, eZ), il = 1 / (length + 1e-37);
    const ddx = eX * il, ddy = eY * il, ddz = eZ * il;
    const velX = V[sb] - V[sa], velY = V[sb + 1] - V[sa + 1], velZ = V[sb + 2] - V[sa + 2];
    const vd = velX * ddx + velY * ddy + velZ * ddz;
    const fa = k * (length - rest) + damp * vd;
    F[sa] += ddx * fa; F[sa + 1] += ddy * fa; F[sa + 2] += ddz * fa;
    F[sb] -= ddx * fa; F[sb + 1] -= ddy * fa; F[sb + 2] -= ddz * fa;
    const rl = Math.min(rest / length, 1), dir = [ddx, ddy, ddz];
    const mm = damp * (vd / Math.max(length, rest));
    const jx = new Array(9), jv = new Array(9);
    for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) {
      const I = a === c ? 1 : 0, dp = dir[a] * dir[c];
      jx[a * 3 + c] = -k * ((I - dp) * rl - I) + (I - dp) * mm;
      jv[a * 3 + c] = dp * damp;
    }
    const AA = s.a * 9, BB = s.b * 9, AB = s.iab * 9, BA = s.iba * 9;
    for (let t = 0; t < 9; t++) {
      dFdX[AA + t] -= jx[t]; dFdX[BB + t] -= jx[t]; dFdX[AB + t] += jx[t]; dFdX[BA + t] += jx[t];
      dFdV[AA + t] -= jv[t]; dFdV[BB + t] -= jv[t]; dFdV[AB + t] += jv[t]; dFdV[BA + t] += jv[t];
    }
  }

  // Filtrerad konjugerad gradient för A · dV = b (fästa partiklar rör sig inte)
  function solve() {
    dV.fill(0);
    mulM(tmp, A, dV);
    for (let i = 0; i < n3; i++) r[i] = b[i] - tmp[i];
    filter(r);
    d.set(r);
    let s = dot(r, r);
    const target = s * o.cgEpsilon * o.cgEpsilon;
    let loops = 0;
    while (s > target && loops++ < o.cgIterations) {
      mulM(q, A, d);
      filter(q);
      const a = s / (dot(d, q) || 1e-30);
      for (let i = 0; i < n3; i++) { dV[i] += d[i] * a; r[i] -= q[i] * a; }
      const last = s;
      s = dot(r, r);
      const beta = s / last;
      for (let i = 0; i < n3; i++) d[i] = r[i] + d[i] * beta;
      filter(d);
    }
    return loops;
  }

  function simulate(dt, windAt) {
    calcForces(windAt);
    const dt2 = dt * dt;
    // A = M - dt·dF/dV - dt²·dF/dX
    for (let p = 0; p < B; p++) {
      const m = p * 9, diag = p < n ? mass[p] : 0;
      for (let t = 0; t < 9; t++) A[m + t] = (t === 0 || t === 4 || t === 8 ? diag : 0) - dFdV[m + t] * dt - dFdX[m + t] * dt2;
    }
    mulM(tmp, dFdX, V);
    for (let i = 0; i < n3; i++) b[i] = F[i] * dt + tmp[i] * dt2;
    const loops = solve();
    for (let i = 0; i < n3; i++) { V[i] += dV[i]; X[i] += V[i] * dt; }
    for (let k = 0; k < n; k++) {
      if (!fixed(k)) continue;
      const i = k * 3, src = pinned[k] ? pin : null;
      if (src) { X[i] = src[i]; X[i + 1] = src[i + 1]; X[i + 2] = src[i + 2]; V[i] = V[i + 1] = V[i + 2] = 0; }
      else { V[i] = (grabAt[0] - X[i]) / dt * 0.5; V[i + 1] = (grabAt[1] - X[i + 1]) / dt * 0.5; V[i + 2] = (grabAt[2] - X[i + 2]) / dt * 0.5; X[i] = grabAt[0]; X[i + 1] = grabAt[1]; X[i + 2] = grabAt[2]; }
    }
    return loops;
  }

  let acc = 0, lastLoops = 0;
  const sync = () => { positions.set(X); normals.set(N); };
  sync();
  return {
    positions, normals, uvs, indices, nx, ny, count: n,
    // dt i sekunder; simuleringen går i fasta steg (timeStep), högst maxSteps per anrop
    step(dt, windAt) {
      acc = Math.min(acc + dt, o.timeStep * o.maxSteps);
      let did = false;
      while (acc >= o.timeStep) { lastLoops = simulate(o.timeStep, windAt); acc -= o.timeStep; did = true; }
      if (did) { calcNormals(); sync(); }
      return did;
    },
    grab(i, target) { grabbed = target ? i : -1; if (target) grabAt.set(target); },
    nearest(p) {
      let best = -1, bd = Infinity;
      for (let k = 0; k < n; k++) {
        if (pinned[k]) continue;
        const d2 = (X[k * 3] - p[0]) ** 2 + (X[k * 3 + 1] - p[1]) ** 2 + (X[k * 3 + 2] - p[2]) ** 2;
        if (d2 < bd) { bd = d2; best = k; }
      }
      return best;
    },
    // För prov: längsta töjning av sträckfjädrarna och CG-varv i senaste steget
    stats() {
      let stretch = 0;
      for (const s of springs) if (s.k === o.structK) stretch = Math.max(stretch, Math.hypot(X[s.b * 3] - X[s.a * 3], X[s.b * 3 + 1] - X[s.a * 3 + 1], X[s.b * 3 + 2] - X[s.a * 3 + 2]) / s.rest - 1);
      return { stretch, cg: lastLoops, finite: X.every(Number.isFinite) };
    },
  };
}
