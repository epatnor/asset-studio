// Granens lövverk: en solid, flikig barrgren längs VARJE riktig gren i skelettet (nivå 1),
// från stammens axel till grenspetsen. Barren följer alltså exakt grenen de sitter på.
// Med frond-atlas får kanten alfa (spretiga barr); utan är grenarna helt solida.
import { add, sub, mul, cross, norm, lerp, clamp01, UP, rng } from './vec.mjs';
import { sampleBranch } from './skeleton.mjs';

const empty = () => ({ positions: [], normals: [], uvs: [], colors: [], wind: [], cluster: [], indices: [] });

function smoothNormals(g) {
  const n = new Float64Array(g.positions.length);
  for (let i = 0; i < g.indices.length; i += 3) {
    const [a, b, c] = [g.indices[i], g.indices[i + 1], g.indices[i + 2]];
    const P = (k) => [g.positions[k * 3], g.positions[k * 3 + 1], g.positions[k * 3 + 2]];
    const fn = cross(sub(P(b), P(a)), sub(P(c), P(a)));
    for (const k of [a, b, c]) for (let j = 0; j < 3; j++) n[k * 3 + j] += fn[j];
  }
  for (let k = 0; k < g.positions.length / 3; k++) {
    const v = norm([n[k * 3], n[k * 3 + 1], n[k * 3 + 2]]);
    g.normals[k * 3] = v[0]; g.normals[k * 3 + 1] = v[1]; g.normals[k * 3 + 2] = v[2];
  }
}

// En barrgren längs center(u): bredast vid ~55 %, flikig ytterkant, välvd ovansida, tunnare undersida
function frond(g, center, width, lobes, lobeDepth, thick, segL, segW, shade, fid, cell, warm, fan = false) {
  const start = g.positions.length / 3;
  const halfW = (u) => {
    // fan: solfjäder som blir bredare utåt och rundas av först i yttersta spetsen (referensens gran);
    // annars bredast på mitten
    const body = fan
      ? (0.18 + 0.82 * Math.min(1, u / 0.8) ** 0.75) * Math.sqrt(Math.max(0, 1 - Math.max(0, (u - 0.82) / 0.18) ** 2)) * width * 0.5
      : Math.sin(Math.PI * Math.min(1, u * 1.05) ** 0.8) * width * 0.5;
    return body * (1 - lobeDepth * Math.abs(Math.sin(u * Math.PI * lobes)) * clamp01((u - 0.3) / 0.4));
  };
  for (const layer of [0, 1]) {
    for (let i = 0; i <= segL; i++) {
      const u = i / segL;
      const c = center(u);
      const tangent = norm(sub(center(Math.min(1, u + 0.02)), center(Math.max(0, u - 0.02))));
      const side = norm(cross(UP, tangent));
      const up = norm(cross(side, tangent));
      for (let j = 0; j <= segW; j++) {
        const s = (j / segW) * 2 - 1, w = halfW(u);
        const arch = (1 - s * s) * thick * (1 - u * 0.6);
        const y = layer === 0 ? arch : -thick * 0.35 * (1 - s * s) * (1 - u * 0.6);
        const p = add(c, add(mul(side, s * w), mul(up, y - Math.abs(s) * w * 0.25)));
        g.positions.push(...p);
        g.normals.push(0, 0, 0);
        if (cell >= 0) g.uvs.push((cell % 2) * 0.5 + ((s + 1) / 2) * 0.5, Math.floor(cell / 2) * 0.5 + (1 - u) * 0.5);
        else g.uvs.push(u, (s + 1) / 2);
        const col = shade(p, u, layer);
        g.colors.push(...(warm ? col.map((x, k) => Math.min(1, x * warm[k])) : col));
        g.wind.push(0.2 + 0.8 * u);
        g.cluster.push(fid);
      }
    }
  }
  const row = segW + 1, layerSize = (segL + 1) * row;
  for (let i = 0; i < segL; i++) for (let j = 0; j < segW; j++) {
    const a = start + i * row + j, b = a + row;
    g.indices.push(a, b, a + 1, a + 1, b, b + 1);
    const A = a + layerSize, B = b + layerSize;
    g.indices.push(A, A + 1, B, A + 1, B + 1, B);
  }
  for (let i = 0; i < segL; i++) for (const j of [0, segW]) {
    const a = start + i * row + j, b = a + row, A = a + layerSize, B = b + layerSize;
    if (j === 0) g.indices.push(a, A, b, A, B, b);
    else g.indices.push(a, b, A, A, b, B);
  }
  for (let j = 0; j < segW; j++) {
    const a = start + segL * row + j, A = a + layerSize;
    g.indices.push(a, a + 1, A, a + 1, A + 1, A);
  }
}

/**
 * @param {object} sk  skelett (skalat)
 * @param {object} o   { seed, height, width, lobes, lobeDepth, chunk, asymmetry, dryShare, textured, palette, normalBlend }
 */
export function buildConiferFoliage(sk, o) {
  const r = rng(o.seed * 104729 + 7);
  const H = o.height;
  const L1 = sk.branches.filter((b) => b.level === 1);
  const crownBottom = Math.min(...L1.map((b) => b.nodes[0].p[1])), crownTop = H;

  const shade = (p, u, layer) => {
    const hN = clamp01((p[1] - crownBottom) / (crownTop - crownBottom));
    const light = clamp01(0.15 + 0.45 * u + 0.3 * hN) * (layer ? 0.55 : 1);
    return light < 0.5 ? lerp(o.palette.dark, o.palette.mid, light * 2) : lerp(o.palette.mid, o.palette.light, (light - 0.5) * 2);
  };

  // Asymmetri: åt ett slumpat håll blir grenarna lite bredare, så kronan inte blir en perfekt kon
  const biasA = r() * Math.PI * 2;
  const fronds = L1.map((b) => {
    const tip = b.nodes[b.nodes.length - 1].p, base = b.nodes[0].p;
    const az = Math.atan2(tip[2] - base[2], tip[0] - base[0]);
    return {
      b, prio: r(), cell: Math.floor(r() * 4), warm: r() < o.dryShare ? [1.18, 1.05, 0.62] : null,
      width: b.length * o.width * (0.9 + r() * 0.2) * (1 + o.asymmetry * Math.cos(az - biasA)),
      thick: b.length * 0.07 * o.chunk, k: clamp01((base[1] - crownBottom) / (crownTop - crownBottom)),
    };
  });

  // Toppen: en uppåtriktad tofs på stammens spets, så toppen inte blir en kal pinne
  const trunk = sk.branches[0];
  const top = trunk.nodes[trunk.nodes.length - 1].p;
  const topLen = H * 0.12;
  const lodDefs = [{ segL: 8, segW: 6, keep: 1 }, { segL: 5, segW: 4, keep: 0.8 }, { segL: 3, segW: 2, keep: 0.6 }];
  const lods = lodDefs.map(({ segL, segW, keep }) => {
    const g = empty();
    fronds.forEach((f, fid) => {
      if (f.prio >= keep && f.k < 0.8) return; // toppens grenar behålls alltid
      const widen = (1 + (1 - keep) * 0.6) * (o.textured ? 1.35 : 1);
      // Barren följer grenen exakt: mittlinjen är grenens egen axel
      const center = (u) => sampleBranch(f.b, u).p;
      frond(g, center, f.width * widen, o.lobes, o.textured ? o.lobeDepth * 0.4 : o.lobeDepth,
        f.thick, segL, segW, shade, fid, o.textured ? f.cell : -1, f.warm, o.fan);
    });
    // Lätt lutande: rakt uppåt skulle göra sidriktningen cross(UP, tangent) odefinierad
    // Tofs i toppen: en krans av korta barrgrenar som pekar uppåt (~30° från lodlinjen) runt en mittgren
    const tuft = o.tuft ?? 6;
    const tuftBase = sub(top, [0, topLen * 1.1, 0]);
    for (let j = 0; tuft > 0 && j <= tuft; j++) {
      const mid = j === tuft;
      const a = (j / tuft) * Math.PI * 2 + 0.4;
      const tilt = mid ? 0.1 : 0.75;
      const dir = norm([Math.cos(a) * tilt, 1, Math.sin(a) * tilt]);
      const len = topLen * (mid ? 1.5 : 0.85 + (j % 2) * 0.2);
      const c = (u) => add(add(tuftBase, [0, mid ? 0 : topLen * 0.25 * (j % 3) / 2, 0]), mul(dir, len * u));
      frond(g, c, len * (mid ? 0.5 : 0.7), 2, 0.25, len * 0.08, segL, segW, shade, fronds.length + j, o.textured ? j % 4 : -1, null);
    }
    smoothNormals(g);
    // Mjuk stiliserad skuggning: blanda normalen mot en kon-normal (ut från stammen och uppåt)
    for (let i = 0; i < g.positions.length; i += 3) {
      const p = [g.positions[i], g.positions[i + 1], g.positions[i + 2]];
      const cone = norm([p[0], Math.hypot(p[0], p[2]) * 0.6 + H * 0.02, p[2]]);
      const n = norm(lerp([g.normals[i], g.normals[i + 1], g.normals[i + 2]], cone, o.normalBlend));
      g.normals[i] = n[0]; g.normals[i + 1] = n[1]; g.normals[i + 2] = n[2];
    }
    return g;
  });
  return { lods, fronds: fronds.length };
}
