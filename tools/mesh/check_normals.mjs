// Kontroll av normaler och vända ytor i modellerna, utan bilder. Två fel letas upp:
// Dubbelsidiga delar och delar med alfa (lövkort, strån, kronblad) hoppas över (skipped): deras normaler är med avsikt
// kronans eller växtens (stilguidens kronnormaler), inte ytans, och båda sidorna delar dem.
// Tvåsidiga par (samma triangel två gånger med motsatt lindning, som växternas strån) räknas inte heller (paired).
// Undantag: ett slutet nät (få öppna kanter, under closedMax) mäts även när materialet är dubbelsidigt, som figurernas
// hud (MPFB exporteras dubbelsidig); annars mättes figurerna aldrig (closedDouble räknar dem). En del utan material
// har glTF:s standardmaterial (ogenomskinligt, enkelsidigt) och mäts (de riggade figurerna saknar material på kroppen).
// - self_intersect: figurer (under assets/characters/ eller riggade nät; {"intersect": true} för alla slutna nät) vars
//   trianglar skär varandra utan att dela hörn, som när wrapen drar läpparna ut genom hakan. Värdet är antalet inblandade
//   trianglar (gräns intersectMax, standard 10). Ett veck syns inte som vända normaler: exporten räknar om normalerna efter den vikta
//   ytan. Generatorernas modeller byggs av delar som går in i varandra (plankor, grenar, strån), så där kollas det inte.
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
const INTERSECT_MAX = args.intersectMax ?? 10; // en ren MPFB-man med vikt 0,8 har 4 (låren och armhålorna möts)
const CLOSED_MAX = args.closedMax ?? 0.06;
// Skär sträckan p→q triangeln [a, b, c] inne i båda (inte i en kant eller ett hörn)?
const segHit = (p, q, [a, b, c]) => {
  const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const h = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]], det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
  if (Math.abs(det) < 1e-14) return false;
  const f = 1 / det, s = [p[0] - a[0], p[1] - a[1], p[2] - a[2]], u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
  if (u < 1e-6 || u > 1 - 1e-6) return false;
  const r = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]], v = f * (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]);
  if (v < 1e-6 || u + v > 1 - 1e-6) return false;
  const t = f * (e2[0] * r[0] + e2[1] * r[1] + e2[2] * r[2]);
  return t > 1e-6 && t < 1 - 1e-6;
};
// Trianglar som skär varandra utan att dela ett hörnläge, med ett rutnät över deras lådor (ca 64 rutor över biten)
function selfIntersecting(tris) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const q of t.p) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
  const C = Math.max(1e-4, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 64), grid = new Map();
  tris.forEach((t, n) => {
    const a = [0, 1, 2].map((k) => Math.floor((Math.min(t.p[0][k], t.p[1][k], t.p[2][k]) - lo[k]) / C)), b = [0, 1, 2].map((k) => Math.floor((Math.max(t.p[0][k], t.p[1][k], t.p[2][k]) - lo[k]) / C));
    for (let x = a[0]; x <= b[0]; x++) for (let y = a[1]; y <= b[1]; y++) for (let z = a[2]; z <= b[2]; z++) { const k = (x * 128 + y) * 128 + z; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(n); }
  });
  const seen = new Set(), hit = new Set();
  for (const list of grid.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
    const a = list[i], b = list[j], k = a < b ? a * 4194304 + b : b * 4194304 + a;
    if (seen.has(k)) continue;
    seen.add(k);
    const A = tris[a], B = tris[b];
    if (A.id.some((x) => B.id.includes(x))) continue;
    for (let e = 0; e < 3; e++) if (segHit(A.p[e], A.p[(e + 1) % 3], B.p) || segHit(B.p[e], B.p[(e + 1) % 3], A.p)) { hit.add(a); hit.add(b); break; }
  }
  return hit.size;
}
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
let prims = 0, tris = 0, skipped = 0, pairedTris = 0, closedDouble = 0;
for (const f of files) {
  const doc = await nio.read(f);
  // Figurer: under assets/characters/, eller nät som hänger på ett skelett
  const skinned = new Set(doc.getRoot().listNodes().filter((n) => n.getSkin() && n.getMesh()).map((n) => n.getMesh()));
  const figureFile = /(^|\/)assets\/characters\//.test(path.relative(ROOT, f).split(path.sep).join('/'));
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION'), nrm = prim.getAttribute('NORMAL');
    if (!pos || !nrm || prim.getMode() !== 4) continue;
    const mat = prim.getMaterial();
    const idx = prim.getIndices()?.getArray() ?? Uint32Array.from({ length: pos.getCount() }, (_, i) => i);
    const P = (i) => pos.getElement(i, [0, 0, 0]), N = (i) => nrm.getElement(i, [0, 0, 0]);
    // Öppna kanter (en triangel per kant, efter hörnens lägen): ett kort eller strå är nästan bara öppna kanter,
    // en kropp nästan inga (bara ögon- och munöppningar)
    const double = mat?.getDoubleSided() ?? false, opaque = (mat?.getAlphaMode() ?? 'OPAQUE') === 'OPAQUE';
    let closed = false;
    if (opaque) {
      const ek = (i, j) => { const a = P(i).map((x) => Math.round(x * 1e4)).join(), b = P(j).map((x) => Math.round(x * 1e4)).join(); return a < b ? a + '|' + b : b + '|' + a; };
      const edges = new Map();
      for (let t = 0; t < idx.length; t += 3) for (const [i, j] of [[0, 1], [1, 2], [2, 0]]) { const k = ek(idx[t + i], idx[t + j]); edges.set(k, (edges.get(k) ?? 0) + 1); }
      let open = 0;
      for (const n of edges.values()) if (n === 1) open++;
      closed = edges.size > 0 && open / edges.size < CLOSED_MAX;
      if (closed && double) closedDouble++;
    }
    const solid = opaque && (!double || closed);
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
    if (closed && (args.intersect === true || (args.intersect !== false && (figureFile || skinned.has(mesh))))) {
      const vk = new Map(), vid = (i) => { const k = P(i).map((x) => Math.round(x * 1e5)).join(); if (!vk.has(k)) vk.set(k, vk.size); return vk.get(k); };
      const T = [];
      for (let t = 0; t < idx.length; t += 3) T.push({ p: [P(idx[t]), P(idx[t + 1]), P(idx[t + 2])], id: [vid(idx[t]), vid(idx[t + 1]), vid(idx[t + 2])] });
      const n = selfIntersecting(T);
      if (n > INTERSECT_MAX) bad.push({ ...where, self_intersect: n });
    }
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
console.log(JSON.stringify({ ok: bad.length === 0, models: files.length, primitives: prims, tris, skipped, closed_double: closedDouble, paired: pairedTris, problems: bad.length, bad: bad.slice(0, args.limit ?? 40) }));
