// Kroppens proportioner mätta som i en referensbild: en ortografisk siluett framifrån, där bredden på en
// höjd är den sammanhängande sträckan runt mittlinjen (armarna räknas inte där det finns en lucka).
// Samma definitioner som mätningen av referensbilderna, så att siffrorna går att jämföra direkt.
//   axlar: bredast i 14–26 % av höjden uppifrån; midja: smalast i 33–48 %; höft: bredast därifrån till 57 %;
//   gren: första höjd under höften där mittlinjen är tom; överarm på 36 %, lår på 60 %, vad på 80 %.
//   Allt som andel av kroppshöjden.

// Siluettens sträckor på höjden y (unionen av trianglarnas snitt i xy-planet)
function intervalsAt(P, tris, y) {
  const segs = [];
  for (const [a, b, c] of tris) {
    const pts = [P[a], P[b], P[c]], xs = [];
    for (let k = 0; k < 3; k++) {
      const p = pts[k], q = pts[(k + 1) % 3];
      if ((p[1] - y) * (q[1] - y) <= 0 && p[1] !== q[1]) xs.push(p[0] + ((y - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
    }
    if (xs.length >= 2) segs.push([Math.min(...xs), Math.max(...xs)]);
  }
  segs.sort((s, t) => s[0] - t[0]);
  const out = [];
  for (const s of segs) { const l = out[out.length - 1]; if (l && s[0] <= l[1] + 1e-4) l[1] = Math.max(l[1], s[1]); else out.push([...s]); }
  return out;
}

export function measureBody(P, tris, cx = 0) {
  const ys = P.map((p) => p[1]), top = Math.max(...ys), bot = Math.min(...ys), H = top - bot;
  const width = (y) => { const iv = intervalsAt(P, tris, y).find(([l, r]) => l <= cx && cx <= r); return iv ? iv[1] - iv[0] : 0; };
  const yAt = (f) => top - f * H;
  const scan = (f0, f1, pick) => {
    let best = null;
    for (let f = f0; f <= f1; f += 0.004) { const w = width(yAt(f)); if (!best || pick(w, best.w)) best = { f, w }; }
    return best;
  };
  const sh = scan(0.14, 0.26, (w, b) => w > b), wa = scan(0.33, 0.48, (w, b) => w < b), hi = scan(wa.f, 0.57, (w, b) => w > b);
  let crotch = null;
  for (let f = hi.f; f < 1; f += 0.002) if (width(yAt(f)) === 0) { crotch = f; break; }
  // Lemmar: överarmen (yttersta sträckan på ena sidan om bålen, om armen syns fri), lår och vad (benet närmast
  // mittlinjen på samma sida)
  const limb = (f, which) => {
    const iv = intervalsAt(P, tris, yAt(f)), c = iv.find(([l, r]) => l <= cx && cx <= r);
    if (which === 'arm') { if (!c || iv.length < 3) return null; const side = iv.filter(([, r]) => r < c[0]); return side.length ? side[0][1] - side[0][0] : null; }
    const side = iv.filter(([, r]) => r < cx); return side.length ? side[side.length - 1][1] - side[side.length - 1][0] : null;
  };
  const r3 = (x) => (x == null ? null : +x.toFixed(3));
  const lm = (f, w) => { const v = limb(f, w); return v == null ? null : r3(v / H); };
  return { height: r3(H), shoulders_H: r3(sh.w / H), waist_H: r3(wa.w / H), hips_H: r3(hi.w / H), crotch_from_floor_H: crotch ? r3(1 - crotch) : null, shoulder_y_H: r3(sh.f),
    arm_H: lm(0.36, 'arm'), thigh_H: lm(0.60, 'leg'), calf_H: lm(0.80, 'leg') };
}
