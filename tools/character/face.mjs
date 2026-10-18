// Ansiktets delar som egna meshar i outfit-formatet (outfit.mjs): ögonglober. Ren JS.
//
// Ögonen sitter där hm08:s ögonhjälpare sitter (efter targets och stilisering), tittar längs eye-target-
// ledernas riktning och följer huvudet. Färgen ligger i hörnen: vita (inte helt vit), iris med mörkare
// limbalring, pupill; hornhinnan buktar lite utåt över irisen så att den fångar en högdager.
import { add, sub, mul, cross, norm, dot } from '../tree/vec.mjs';

const linear = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
const mix = (a, b, t) => a.map((x, i) => x + (b[i] - x) * t);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// opts: iris (#RRGGBB), irisAngle och pupilAngle (radianer från blickriktningen), segments
export function buildEyes(body, opts = {}) {
  const iris = linear(opts.iris ?? '#4C7A9E'), sclera = linear(opts.sclera ?? '#EDE4DA'), pupil = linear('#141210');
  const limbal = mix(iris, pupil, 0.6);
  const irisA = opts.irisAngle ?? 0.55, pupilA = opts.pupilAngle ?? 0.22;
  const segU = opts.segments ?? 28, segV = Math.round(segU * 0.6);
  // Huvudets närmaste kroppshörn: ögonen ärver dess vikter och följer huvudet
  const nearest = (c) => body.verts.reduce((best, p, i) => (Math.hypot(...sub(p, c)) < Math.hypot(...sub(body.verts[best], c)) ? i : best), 0);
  return body.eyes.map((e, ei) => {
    const d = norm(e.dir), ref = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(ref, d)), v = cross(d, u);
    const pos = [], col = [], nrm = [], tris = [];
    for (let j = 0; j <= segV; j++) {
      const th = (Math.PI * j) / segV; // 0 = blickriktningen
      for (let k = 0; k < segU; k++) {
        const ph = (2 * Math.PI * k) / segU;
        const dirv = add(mul(d, Math.cos(th)), add(mul(u, Math.sin(th) * Math.cos(ph)), mul(v, Math.sin(th) * Math.sin(ph))));
        const bulge = 1 + 0.07 * (1 - smooth(0, irisA * 1.1, th));
        pos.push(add(e.center, mul(dirv, e.radius * bulge)));
        nrm.push(dirv);
        let c = th < pupilA ? pupil : th < irisA ? mix(iris, limbal, smooth(irisA * 0.6, irisA, th)) : sclera;
        if (th >= irisA) c = mix(limbal, sclera, smooth(irisA, irisA * 1.12, th));
        col.push(c);
      }
    }
    for (let j = 0; j < segV; j++) for (let k = 0; k < segU; k++) {
      const a = j * segU + k, b = j * segU + ((k + 1) % segU), c = a + segU, dd = b + segU;
      tris.push([a, c, b], [b, c, dd]);
    }
    // Vänd trianglarna utåt om de pekar in
    const t0 = tris[segU];
    if (dot(cross(sub(pos[t0[1]], pos[t0[0]]), sub(pos[t0[2]], pos[t0[0]])), sub(pos[t0[0]], e.center)) < 0) tris.forEach((t) => t.reverse());
    const src = [[nearest(e.center), 1]];
    return { slot: ei === 0 ? 'eye_L' : 'eye_R', material: 'eye', kind: 'eye', pos, nrm, col, src: pos.map(() => src), key: pos.map((_, i) => `eye${ei},${i}`), tris, strip: tris.map(() => false) };
  });
}
