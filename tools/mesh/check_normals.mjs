// Kontroll av normaler och vända ytor i modellerna, utan bilder. Två fel letas upp:
// Dubbelsidiga delar och delar med alfa (lövkort, strån, kronblad) hoppas över (skipped): deras normaler är med avsikt
// kronans eller växtens (stilguidens kronnormaler), inte ytans, och båda sidorna delar dem.
// Tvåsidiga par (samma triangel två gånger med motsatt lindning, som växternas strån) räknas inte heller (paired).
// - flipped: trianglar vars lindning (framsidan, moturs) pekar åt motsatt håll mot hörnens normaler. De syns som
//   hål när baksidan skärs bort, eller får ljuset från fel håll. Andelen räknas efter yta.
// - inside_out: ogenomskinliga, enkelsidiga bitar (stenar, stammar, hattar) vars framsidor pekar inåt: en stråle från
//   ytan utåt träffar biten själv ett udda antal gånger. Värdet är andelen ytor som pekar inåt.
//
//   node tools/mesh/check_normals.mjs '{"paths": ["assets/trees", "build/slim"]}'      mappar eller .gltf/.glb
//   node tools/mesh/check_normals.mjs '{"world": "../godot-lab/worlds/flag_isle_lean"}'   modellerna i en export
// Svarar med en rad JSON: antal modeller, de med fel (modell, del, andel) och ok.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io } from '../tree/gltf_write.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = JSON.parse(process.argv[2] ?? '{}');
const FLIP_MAX = args.flipMax ?? 0.02, OUT_MIN = args.outMin ?? 0.5, SAMPLES = args.samples ?? 120;
// Möller–Trumbore: träffar strålen (o, d) triangeln [a, b, c] framför o?
const rayHit = (o, d, [a, b, c]) => {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
  const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det, s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]], u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
  if (v < 0 || u + v > 1) return false;
  return f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) > 1e-6;
};

const files = [];
const walk = (p) => {
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  else if (/\.(gltf|glb)$/i.test(p)) files.push(p);
};
for (const p of args.paths ?? []) walk(path.resolve(ROOT, p));
if (args.world) walk(path.join(path.resolve(ROOT, args.world), 'models'));

const nio = await io();
const bad = [];
let prims = 0, tris = 0, skipped = 0, pairedTris = 0;
for (const f of files) {
  const doc = await nio.read(f);
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), nrm = prim.getAttribute('NORMAL');
    if (!pos || !nrm || prim.getMode() !== 4) continue;
    const mat = prim.getMaterial(), solid = mat && !mat.getDoubleSided() && mat.getAlphaMode() === 'OPAQUE';
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.getCount() }, (_, i) => i);
    const P = (i) => pos.getElement(i, [0, 0, 0]), N = (i) => nrm.getElement(i, [0, 0, 0]);
    let area = 0, flipArea = 0;
    // Sammanhängande bitar (union-find över hörnens lägen, så att delade kanter med egna hörn räknas ihop)
    const key = new Map(), parent = [];
    const id = (i) => { const p = P(i), k = p.map((x) => Math.round(x * 1e4)).join(); if (!key.has(k)) { key.set(k, parent.length); parent.push(parent.length); } return key.get(k); };
    const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
    const faces = [];
    // Tvåsidiga par: samma tre lägen med motsatt lindning (växternas strån och blad byggs så, med gemensam normal)
    const pk = (i) => P(i).map((x) => Math.round(x * 1e4)).join();
    const tri = new Map();
    for (let t = 0; t < idx.length; t += 3) {
      const ks = [pk(idx[t]), pk(idx[t + 1]), pk(idx[t + 2])], s = [...ks].sort().join('|');
      if (!tri.has(s)) tri.set(s, []);
      tri.get(s).push(t);
    }
    const paired = new Set();
    for (const list of tri.values()) if (list.length > 1) for (const t of list) paired.add(t);
    for (let t = 0; t < idx.length; t += 3) {
      if (paired.has(t)) { pairedTris++; continue; }
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]], pa = P(a), pb = P(b), pc = P(c);
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const ar = Math.hypot(...fn) / 2;
      if (ar < 1e-12) continue;
      const vn = [0, 1, 2].map((k) => N(a)[k] + N(b)[k] + N(c)[k]);
      area += ar;
      if (fn[0] * vn[0] + fn[1] * vn[1] + fn[2] * vn[2] < 0) flipArea += ar;
      if (solid) {
        const [ia, ib, ic] = [id(a), id(b), id(c)];
        parent[find(ib)] = find(ia); parent[find(ic)] = find(ia);
        faces.push({ ia, ib, ic, fn, vn, ar, p: [pa, pb, pc], m: [(pa[0] + pb[0] + pc[0]) / 3, (pa[1] + pb[1] + pc[1]) / 3, (pa[2] + pb[2] + pc[2]) / 3] });
      }
    }
    prims++; tris += idx.length / 3;
    const where = { model: path.relative(ROOT, f), mesh: mesh.getName(), material: mat?.getName() ?? '' };
    if (!solid) { skipped++; continue; }
    if (area && flipArea / area > FLIP_MAX) bad.push({ ...where, flipped: +(flipArea / area).toFixed(3) });
    if (solid && faces.length) {
      // Per bit: strålar från ett urval ytor, utåt längs ytans framsida. Träffar strålen biten själv ett udda antal gånger
      // ligger framsidan inåt. Fungerar även för öppna och skålformade ytor (strålen från en skål uppåt går fritt).
      const comp = new Map();
      for (const fc of faces) {
        const r = find(fc.ia);
        if (!comp.has(r)) comp.set(r, []);
        comp.get(r).push(fc);
      }
      let worst = 1;
      for (const list of comp.values()) {
        if (list.length < 12) continue;
        const step = Math.max(1, Math.floor(list.length / SAMPLES));
        let inward = 0, n = 0;
        for (let i = 0; i < list.length; i += step) {
          const fc = list[i], l = Math.hypot(...fc.fn), d = fc.fn.map((x) => x / l);
          const o = fc.m.map((x, k) => x + d[k] * 1e-4);
          let hits = 0;
          for (const g of list) if (g !== fc && rayHit(o, d, g.p)) hits++;
          if (hits % 2) inward++;
          n++;
        }
        worst = Math.min(worst, 1 - inward / n);
      }
      if (worst < OUT_MIN) bad.push({ ...where, inside_out: +(1 - worst).toFixed(3) });
    }
  }
}
console.log(JSON.stringify({ ok: bad.length === 0, models: files.length, primitives: prims, tris, skipped, paired: pairedTris, problems: bad.length, bad: bad.slice(0, args.limit ?? 40) }));
