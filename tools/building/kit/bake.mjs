// Bakade texturer till byggsatsen (docs/building-kit.md): en vanlig mur och ett vanligt takfall behöver inte
// varje sten och panna som geometri. Här ritas samma murverk (samma skift och fogregler som de modellerade
// stenarna i modules.mjs) och samma skifferrader som höjdkarta, och ur den räknas färg, normalkarta och
// skuggor i fogarna. Texturerna går runt i x (och i taket även uppåt), så att modulerna kan ligga i rad.
// Ut: assets/textures/kit_<namn>.png, _normal.png och _height.png.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { makeRand } from '../house/graph.mjs';
import { courses, fillRun, lin } from './modules.mjs';

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
export function writePng(file, w, h, ch, px) {
  const raw = Buffer.alloc((w * ch + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * ch + 1)] = 0; px.subarray(y * w * ch, (y + 1) * w * ch).forEach((v, i) => { raw[y * (w * ch + 1) + 1 + i] = v; }); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 1 ? 0 : ch === 3 ? 2 : 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]));
}

// ---------- Hjälpare ----------
const toSrgb = (x) => Math.round(255 * Math.min(1, Math.max(0, x)) ** (1 / 2.2));
function valueNoise(seed) {
  const r = makeRand(seed), cache = new Map();
  const g = (i, j) => { const k = i * 92821 + j; if (!cache.has(k)) cache.set(k, r(`${i},${j}`)); return cache.get(k); };
  return (x, y) => {
    const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j, sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    return (g(i, j) * (1 - sx) + g(i + 1, j) * sx) * (1 - sy) + (g(i, j + 1) * (1 - sx) + g(i + 1, j + 1) * sx) * sy;
  };
}
// Rundad kant: hur mycket ytan sjunker d meter från kanten, med fasen b
const edgeDrop = (d, b) => (d >= b ? 0 : b - Math.sqrt(Math.max(0, b * b - (b - d) * (b - d))));

// Färg, normal och höjd ur höjdfältet. hgt: meter, col: linjär färg per pixel. wrapY: går runt även uppåt
function finish(name, W, H, pxM, hgt, col, { wrapY = false, strength = 1.6, lo = -0.05, hi = 0.06, ao = 9 } = {}) {
  const at = (x, y) => hgt[((wrapY ? (y + H) % H : Math.min(H - 1, Math.max(0, y)))) * W + ((x + W) % W)];
  // skugga i fogarna: hur mycket lägre än omgivningen (suddad höjd) en punkt ligger
  const blur = new Float32Array(W * H), tmp = new Float32Array(W * H), R = 6;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let k = -R; k <= R; k++) s += at(x + k, y); tmp[y * W + x] = s / (2 * R + 1); }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let k = -R; k <= R; k++) { const yy = wrapY ? (y + k + H) % H : Math.min(H - 1, Math.max(0, y + k)); s += tmp[yy * W + x]; } blur[y * W + x] = s / (2 * R + 1); }
  const C = new Uint8Array(W * H * 3), N = new Uint8Array(W * H * 3), Hh = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, occ = Math.max(0.45, 1 - ao * Math.max(0, blur[i] - hgt[i]));
    for (let c = 0; c < 3; c++) C[i * 3 + c] = toSrgb(col[i * 3 + c] * occ);
    // bildens rad ökar nedåt, världens y uppåt: dh/dy = −(nedre − övre)
    const dx = ((at(x + 1, y) - at(x - 1, y)) * pxM) / 2, dy = -((at(x, y + 1) - at(x, y - 1)) * pxM) / 2;
    let nx = -dx * strength, ny = -dy * strength, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    N[i * 3] = Math.round((nx * 0.5 + 0.5) * 255); N[i * 3 + 1] = Math.round((ny * 0.5 + 0.5) * 255); N[i * 3 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    Hh[i] = Math.round(255 * Math.min(1, Math.max(0, (hgt[i] - lo) / (hi - lo))));
  }
  const dir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../assets/textures');
  writePng(path.join(dir, `${name}.png`), W, H, 3, C);
  writePng(path.join(dir, `${name}_normal.png`), W, H, 3, N);
  writePng(path.join(dir, `${name}_height.png`), W, H, 1, Hh);
  return { color: `assets/textures/${name}.png`, normal: `assets/textures/${name}_normal.png`, height: `assets/textures/${name}_height.png`, size: [W, H] };
}

// ---------- Murverket ----------
// En panel P meter bred och en våning hög, i skift som går runt i x. Samma skift som de modellerade stenarna
export function bakeMasonry(K, o = {}) {
  const F = K.families.stone, Hm = K.storey, P = o.period ?? F.bake.period, W = o.width ?? F.bake.size[0], H = o.height ?? F.bake.size[1];
  const pxM = W / P, r = makeRand(F.seed + 1000), noise = valueNoise(F.seed + 7), C = courses(F, Hm), m = F.mortar / 2;
  const hgt = new Float32Array(W * H).fill(-F.mortarDepth), col = new Float32Array(W * H * 3), mc = lin(F.mortarColor);
  for (let i = 0; i < W * H; i++) { const x = (i % W) / pxM, y = Hm - Math.floor(i / W) / pxM, n = 0.85 + 0.25 * noise(x * 9, y * 9); col.set(mc.map((c) => c * n), i * 3); hgt[i] += 0.004 * noise(x * 20, y * 20); }
  let joints = [], count = 0;
  C.forEach(([y0, y1], k) => {
    const d = k % 2 ? F.tooth : -F.tooth;
    const below = joints.flatMap((j) => [j - P, j, j + P]);
    const stones = fillRun(F, r, `bk${k}`, d, d + P, below, null, null);
    joints = stones.flatMap((s) => [s.x0, s.x1]);
    for (const [si, s] of stones.entries()) {
      count++;
      const key = `b${k}_${si}`, ins = (q) => m + F.inset * r(`${key}${q}`);
      const xa = s.x0 + ins('l'), xb = s.x1 - ins('r'), ya = y0 + ins('b'), yb = y1 - ins('t');
      const skew = (r(`${key}sk`) - 0.5) * 0.02, relief = F.relief[0] + (F.relief[1] - F.relief[0]) * r(`${key}z`);
      const dome = F.dome * (0.6 + 0.9 * r(`${key}dm`)), b = F.bevel * 1.25, col0 = lin(F.colors[Math.floor(r(`${key}c`) * F.colors.length) % F.colors.length]).map((c) => c * (0.88 + 0.18 * r(`${key}br`)));
      const chip = r(`${key}ch`) < F.chip[0] ? [r(`${key}cx`) < 0.5 ? xa : xb, r(`${key}cy`) < 0.5 ? ya : yb, F.chip[1] * 1.4] : null;
      const tilt = [(r(`${key}tx`) - 0.5) * 0.02, (r(`${key}ty`) - 0.5) * 0.02];
      for (let rep = -1; rep <= 1; rep++) {
        const ox = rep * P;
        const px0 = Math.floor((xa + ox) * pxM), px1 = Math.ceil((xb + ox) * pxM);
        if (px1 < 0 || px0 >= W) continue;
        const py0 = Math.max(0, Math.floor((Hm - yb) * pxM)), py1 = Math.min(H - 1, Math.ceil((Hm - ya) * pxM));
        for (let py = py0; py <= py1; py++) for (let pxx = Math.max(0, px0); pxx <= Math.min(W - 1, px1); pxx++) {
          const x = pxx / pxM - ox, y = Hm - py / pxM;
          // sneda ovan- och underkanter ger oregelbundna fogar
          const sk = skew * ((x - xa) / (xb - xa) - 0.5);
          const dd = Math.min(x - xa, xb - x, y - (ya + sk), (yb + sk) - y);
          if (dd <= 0) continue;
          const u = ((x - xa) / (xb - xa)) * 2 - 1, v = ((y - ya) / (yb - ya)) * 2 - 1;
          let h = relief + dome * (1 - u * u) * (1 - v * v) + tilt[0] * u + tilt[1] * v - edgeDrop(dd, b);
          h += 0.005 * (noise(x * 7 + k * 3.1, y * 7) - 0.5) + 0.0025 * (noise(x * 25, y * 25 + si) - 0.5);
          if (chip) { const cd = Math.hypot(x - chip[0], y - chip[1]); if (cd < chip[2]) h -= (chip[2] - cd) * 0.45; }
          const i = py * W + pxx;
          if (h <= hgt[i]) continue;
          hgt[i] = h;
          const shadeK = (1 + 0.12 * v) * (dd < b * 0.7 ? 1.14 : 1) * (0.94 + 0.12 * noise(x * 4 + si, y * 4));
          col.set(col0.map((c) => c * shadeK), i * 3);
        }
      }
    }
  });
  return { ...finish(o.name ?? 'kit_masonry', W, H, pxM, hgt, col, { strength: 1.5 }), stones: count, period: P };
}

// ---------- Skiffertaket ----------
// Rader av skifferplattor i sågtandsprofil: varje platta är tjockast vid sin nedre kant och försvinner under
// nästa rad. Går runt i x (2 m) och uppåt (ett jämnt antal rader)
export function bakeSlate(K, o = {}) {
  const Rf = K.families.roof, Wm = K.width, [tw, , tt] = Rf.tile, ex = Rf.exposure, gap = Rf.gap;
  const rows = Rf.bake.rows, Hm = rows * ex, W = Rf.bake.size[0], pxM = W / Wm, H = Math.round(Hm * pxM);
  const r = makeRand(4242), noise = valueNoise(99);
  const hgt = new Float32Array(W * H).fill(-0.012), col = new Float32Array(W * H * 3), dark = lin(Rf.ridgeColor).map((c) => c * 0.45);
  for (let i = 0; i < W * H; i++) col.set(dark, i * 3);
  for (let j = 0; j < rows; j++) {
    const odd = j % 2, sb = j * ex;
    for (let t = 0; t < 7; t++) {
      const cx = odd ? t * tw : (t + 0.5) * tw, key = `s${j}_${t}`;
      const xa = cx - tw / 2 + gap / 2, xb = cx + tw / 2 - gap / 2, butt = sb + (r(`${key}b`) - 0.5) * 0.02;
      const c0 = lin(Rf.colors[Math.floor(r(`${key}c`) * Rf.colors.length) % Rf.colors.length]).map((c) => c * (0.8 + 0.3 * r(`${key}k`)) * (r(`${key}o`) < 0.07 ? 0.7 : 1));
      const round = 0.03 + 0.04 * r(`${key}r`);
      for (const ox of [-Wm, 0, Wm]) for (const oy of [-Hm, 0, Hm]) {
        const px0 = Math.floor((xa + ox) * pxM), px1 = Math.ceil((xb + ox) * pxM);
        // synlig del: från plattans nedre kant upp till nästa rads kant (bilden: s ökar uppåt)
        const s0 = butt + oy, s1 = sb + ex + 0.012 + oy;
        const py0 = Math.floor((Hm - s1) * pxM), py1 = Math.ceil((Hm - s0) * pxM);
        for (let py = Math.max(0, py0); py <= Math.min(H - 1, py1); py++) for (let pxx = Math.max(0, px0); pxx <= Math.min(W - 1, px1); pxx++) {
          const x = pxx / pxM - ox, s = Hm - py / pxM - oy;
          let dd = Math.min(x - xa, xb - x, s - butt);
          // rundade hörn nertill
          const cx2 = Math.min(x - xa, xb - x), sy2 = s - butt;
          if (cx2 < round && sy2 < round) dd = Math.min(dd, round - Math.hypot(round - cx2, round - sy2));
          if (dd <= 0) continue;
          const tt01 = Math.min(1, (s - butt) / ex);
          let h = tt * 0.95 * (1 - tt01) - edgeDrop(dd, 0.01) + 0.003 * (noise(x * 12 + j, s * 12) - 0.5);
          const i = py * W + pxx;
          if (h <= hgt[i]) continue;
          hgt[i] = h;
          const k = (1 + 0.22 * (1 - tt01) - 0.11) * (dd < 0.008 ? 1.12 : 1) * (0.93 + 0.14 * noise(x * 5 + t, s * 5));
          col.set(c0.map((c) => c * k), i * 3);
        }
      }
    }
  }
  return { ...finish(o.name ?? 'kit_slate', W, H, pxM, hgt, col, { wrapY: true, strength: 1.3, ao: 7 }), rows, period: [Wm, Hm] };
}
