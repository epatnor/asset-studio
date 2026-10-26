// Barkmesh från skelettet: ett sammanhängande rör per gren. Barnets första ring ligger på
// förälderns axel och är smalare än föräldern, så fogen är dold inne i föräldern (inga glapp).
// UV i meter (barkRepeat meter per texturupprepning), så barken har samma skala på stam och kvistar.
import { add, sub, mul, dot, cross, norm, len, basis } from './vec.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], blendBase: [], blendTip: [], indices: [] });
const smooth = (x) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

// Jämna normaler för en grens vertexar (från base) ur dess trianglar (från triStart). Sömmen
// (första och sista kolumnen i varje ring) får samma normal, så att den inte syns.
function recomputeNormals(g, base, triStart, row) {
  const nV = g.positions.length / 3 - base;
  const acc = new Float64Array(nV * 3);
  const P = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]];
  for (let i = triStart; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    const fn = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) acc[(k - base) * 3 + j] += fn[j];
  }
  for (let k = 0; k + 1 < nV; k += row) { // laga sömmen: summera första och sista kolumnen
    const e = k + row - 1;
    if (e >= nV - 1) break;
    for (let j = 0; j < 3; j++) { const sum = acc[k * 3 + j] + acc[e * 3 + j]; acc[k * 3 + j] = sum; acc[e * 3 + j] = sum; }
  }
  for (let k = 0; k < nV; k++) {
    const n = norm([acc[k * 3], acc[k * 3 + 1], acc[k * 3 + 2]]);
    g.normals[(base + k) * 3] = n[0]; g.normals[(base + k) * 3 + 1] = n[1]; g.normals[(base + k) * 3 + 2] = n[2];
  }
}

/**
 * @param {object} sk  skelett (efter skalning)
 * @param {object} o   { barkRepeat, maxLevel, segScale, flare, roots, height, top (verklig höjd med stamhöjden) }
 */
export function barkMesh(sk, o) {
  const g = empty();
  for (const b of sk.branches) {
    if (b.level > o.maxLevel) continue;
    const segs = Math.max(3, Math.round(b.segments * o.segScale));
    // topCut: stammen slutar under toppen (granens tofs tar över där)
    let nodes = b.level === 0 && o.topCut ? b.nodes.filter((n, i) => i < 2 || n.p[1] <= o.topCut * (o.top ?? o.height)) : b.nodes;
    // sinkDepth: stammen fortsätter rakt ner under marken, så att en sluttning aldrig visar ett avhugget
    // snitt. Bara geometri: skelettets noder (och grenarnas fästpunkter) ändras inte.
    if (b.level === 0 && o.sinkDepth > 0) {
      const n0 = nodes[0];
      nodes = [{ p: sub(n0.p, [0, o.sinkDepth, 0]), r: n0.r }, { p: sub(n0.p, [0, o.sinkDepth * 0.5, 0]), r: n0.r }, ...nodes];
    }
    const base = g.positions.length / 3;
    // Parallellförflyttade ramar längs grenen (ingen vridning mellan ringarna)
    let d0 = norm(sub(nodes[1].p, nodes[0].p));
    let [n1] = basis(d0);
    let vAcc = 0;
    const circ = 2 * Math.PI * nodes[0].r;
    const uRep = Math.max(1, Math.round(circ / o.barkRepeat));
    for (let i = 0; i < nodes.length; i++) {
      const d = norm(sub(nodes[Math.min(i + 1, nodes.length - 1)].p, nodes[Math.max(i - 1, 0)].p));
      n1 = norm(sub(n1, mul(d, dot(n1, d)))); // projicera förra ramen på nya planet
      const n2 = cross(d, n1);
      if (i > 0) vAcc += len(sub(nodes[i].p, nodes[i - 1].p));
      const t = i / (nodes.length - 1);
      // Vridningen: flikarna vrider sig twist/lobes radianer per höjdenhet, och texturen förskjuts lika mycket runt
      // stammen, så att barkens fåror följer flikarna i en spiral i stället för att gå rakt upp
      const lobed = o.lobes && b.level <= 1;
      const twist = lobed ? (vAcc / o.height) * Math.PI * 2 * (o.twist ?? 1) : 0;
      const uShift = lobed ? (twist / o.lobes / (Math.PI * 2)) * uRep : 0;
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const dir = add(mul(n1, Math.cos(a)), mul(n2, Math.sin(a)));
        let rad = nodes[i].r;
        // Vriden, flikig stam: tvärsnittet får några utbuktningar som vrider sig uppåt och avtar
        // med höjden (stammen fullt ut, första grennivån svagare), plus mjuka svällningar längs grenen
        if (lobed) {
          const fade = b.level === 0 ? 1 - 0.6 * t : 0.5 * (1 - t);
          rad *= 1 + (o.lobeAmp ?? 0.15) * fade * Math.cos(o.lobes * a + twist + b.phase);
          rad *= 1 + (o.bulge ?? 0.05) * Math.sin(vAcc / o.height * 9 + b.phase * 3);
        }
        // Stammens fot: utsvängning och rotknölar
        if (b.level === 0 && o.flare) {
          const h = Math.max(0, nodes[i].p[1]) / (o.height * (o.flareHeight ?? 0.06)); // under marken: full rotbredd
          if (h < 1) rad *= 1 + o.flare * (1 - h) ** 2 * (1 + (o.roots ? (o.rootAmp ?? 0.6) * Math.max(0, Math.cos(o.roots * a)) ** 2 : 0));
        }
        g.positions.push(...add(nodes[i].p, mul(dir, rad)));
        g.normals.push(...dir);
        g.uvs.push((s / segs) * uRep + uShift, vAcc / o.barkRepeat);
        // Mörkare nedtill och mot fästen (enkel AO), ljusare upptill
        const ao = b.level === 0 ? 0.62 + 0.38 * Math.min(1, Math.max(0, nodes[i].p[1]) / (o.height * 0.35)) : 0.78 + 0.22 * t;
        // Gröna toppar (tipTint): de minsta grenarna tonas mot lövfärgen ytterst
        const tw = o.tipTint && b.level >= o.tipLevel ? Math.min(1, Math.max(0, (t - o.tipFrom) / (1 - o.tipFrom))) ** 1.5 : 0;
        g.colors.push(...[0, 1, 2].map((c) => ao + ((o.tipTint?.[c] ?? ao) - ao) * tw));
        g.wind.push(b.level === 0 ? (nodes[i].p[1] / (o.top ?? o.height)) ** 2 * 0.15 : Math.min(1, 0.25 * b.level + 0.4 * t));
        // Texturblandning (bark_blend): påväxt vid foten upp till baseHeight meter, grön textur ytterst på smågrenarna.
        // Bara vikterna räknas här; texturerna blandas i klientens shader med en brusig kant.
        g.blendBase.push(o.baseHeight ? 1 - smooth(Math.max(0, g.positions[g.positions.length - 2]) / o.baseHeight) : 0);
        g.blendTip.push(o.tipBlendLevel != null && b.level >= o.tipBlendLevel ? smooth((t - o.tipBlendFrom) / (1 - o.tipBlendFrom)) : 0);
      }
    }
    const row = segs + 1;
    const triStart = g.indices.length;
    for (let i = 0; i < nodes.length - 1; i++) for (let s = 0; s < segs; s++) {
      const a = base + i * row + s, c = a + row;
      g.indices.push(a, a + 1, c, a + 1, c + 1, c); // moturs sett utifrån (d × tangent pekar inåt)
    }
    // flatTop (stubbar): platt snittyta som egen geometri (g.cap) med planar UV för årsringstextur
    if (o.flatTop && b.level === 0) {
      const last = base + (nodes.length - 1) * row;
      const top = nodes[nodes.length - 1];
      const cap = (g.cap ??= { positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] });
      const cb = cap.positions.length / 3;
      const R = Math.max(...Array.from({ length: segs + 1 }, (_, s) => Math.hypot(g.positions[(last + s) * 3] - top.p[0], g.positions[(last + s) * 3 + 2] - top.p[2])));
      const pushV = (x, y, z) => {
        cap.positions.push(x, y, z); cap.normals.push(0, 1, 0);
        cap.uvs.push(0.5 + (x - top.p[0]) / (2 * R), 0.5 - (z - top.p[2]) / (2 * R));
        cap.colors.push(1, 1, 1); cap.wind.push(0);
      };
      pushV(top.p[0], top.p[1], top.p[2]);
      for (let s = 0; s <= segs; s++) pushV(g.positions[(last + s) * 3], top.p[1], g.positions[(last + s) * 3 + 2]);
      for (let s = 0; s < segs; s++) cap.indices.push(cb, cb + 2 + s, cb + 1 + s);
      // Snittytan ska vetta uppåt: kontrollera första triangeln och vänd allihop om den pekar nedåt
      const P = (k) => [cap.positions[k * 3], cap.positions[k * 3 + 1], cap.positions[k * 3 + 2]];
      const [i0, i1, i2] = cap.indices.slice(-segs * 3, -segs * 3 + 3);
      if (cross(sub(P(i1), P(i0)), sub(P(i2), P(i0)))[1] < 0) {
        for (let k = cap.indices.length - segs * 3; k < cap.indices.length; k += 3) [cap.indices[k + 1], cap.indices[k + 2]] = [cap.indices[k + 2], cap.indices[k + 1]];
      }
      if (o.lobes && b.level <= 1) recomputeNormals(g, base, triStart, row);
      continue;
    }
    // Stäng spetsen med en liten kon
    const tip = nodes[nodes.length - 1];
    const tipDir = norm(sub(tip.p, nodes[nodes.length - 2].p));
    const ti = g.positions.length / 3;
    g.positions.push(...add(tip.p, mul(tipDir, tip.r * 1.5)));
    g.normals.push(...tipDir);
    g.uvs.push(0.5 * uRep, (vAcc + tip.r) / o.barkRepeat);
    g.colors.push(...(o.tipTint && b.level >= o.tipLevel ? o.tipTint : [1, 1, 1]));
    g.wind.push(1);
    g.blendBase.push(o.baseHeight ? 1 - smooth(Math.max(0, g.positions[g.positions.length - 2]) / o.baseHeight) : 0);
    g.blendTip.push(o.tipBlendLevel != null && b.level >= o.tipBlendLevel ? 1 : 0);
    const last = base + (nodes.length - 1) * row;
    for (let s = 0; s < segs; s++) g.indices.push(last + s, last + s + 1, ti);
    if (o.lobes && b.level <= 1) recomputeNormals(g, base, triStart, row);
  }
  return g;
}
