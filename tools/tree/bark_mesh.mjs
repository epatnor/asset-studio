// Barkmesh från skelettet: ett sammanhängande rör per gren. Barnets första ring ligger på
// förälderns axel och är smalare än föräldern, så fogen är dold inne i föräldern (inga glapp).
// UV i meter (barkRepeat meter per texturupprepning), så barken har samma skala på stam och kvistar.
import { add, sub, mul, dot, cross, norm, len, basis } from './vec.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], indices: [] });

/**
 * @param {object} sk  skelett (efter skalning)
 * @param {object} o   { barkRepeat, maxLevel, segScale, flare, roots, height }
 */
export function barkMesh(sk, o) {
  const g = empty();
  for (const b of sk.branches) {
    if (b.level > o.maxLevel) continue;
    const segs = Math.max(3, Math.round(b.segments * o.segScale));
    const nodes = b.nodes;
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
      for (let s = 0; s <= segs; s++) {
        const a = (s / segs) * Math.PI * 2;
        const dir = add(mul(n1, Math.cos(a)), mul(n2, Math.sin(a)));
        let rad = nodes[i].r;
        // Stammens fot: utsvängning och rotknölar
        if (b.level === 0 && o.flare) {
          const h = nodes[i].p[1] / (o.height * (o.flareHeight ?? 0.06));
          if (h < 1) rad *= 1 + o.flare * (1 - h) ** 2 * (1 + (o.roots ? (o.rootAmp ?? 0.6) * Math.max(0, Math.cos(o.roots * a)) ** 2 : 0));
        }
        g.positions.push(...add(nodes[i].p, mul(dir, rad)));
        g.normals.push(...dir);
        g.uvs.push((s / segs) * uRep, vAcc / o.barkRepeat);
        // Mörkare nedtill och mot fästen (enkel AO), ljusare upptill
        const ao = b.level === 0 ? 0.62 + 0.38 * Math.min(1, nodes[i].p[1] / (o.height * 0.35)) : 0.78 + 0.22 * t;
        g.colors.push(ao, ao, ao);
        g.wind.push(b.level === 0 ? (nodes[i].p[1] / o.height) ** 2 * 0.15 : Math.min(1, 0.25 * b.level + 0.4 * t));
      }
    }
    const row = segs + 1;
    for (let i = 0; i < nodes.length - 1; i++) for (let s = 0; s < segs; s++) {
      const a = base + i * row + s, c = a + row;
      g.indices.push(a, a + 1, c, a + 1, c + 1, c); // moturs sett utifrån (d × tangent pekar inåt)
    }
    // Stäng spetsen med en liten kon
    const tip = nodes[nodes.length - 1];
    const tipDir = norm(sub(tip.p, nodes[nodes.length - 2].p));
    const ti = g.positions.length / 3;
    g.positions.push(...add(tip.p, mul(tipDir, tip.r * 1.5)));
    g.normals.push(...tipDir);
    g.uvs.push(0.5 * uRep, (vAcc + tip.r) / o.barkRepeat);
    g.colors.push(1, 1, 1);
    g.wind.push(1);
    const last = base + (nodes.length - 1) * row;
    for (let s = 0; s < segs; s++) g.indices.push(last + s, last + s + 1, ti);
  }
  return g;
}
