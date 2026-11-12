"""Texture jumps on a head turntable: the flow between consecutive frames comes from the Pixal3D render (same geometry and
cameras for every model, consistent paint); each model's frame i is warped with it onto frame i+1, and what is left is
paint that moved between views. Prints one line of JSON per model: mean and worst residual over the face."""
import json, sys, glob
from pathlib import Path
import cv2, numpy as np
root = Path(sys.argv[1]); base = sys.argv[2]; models = sys.argv[3:]
def frames(m):
    fs = sorted(glob.glob(str(root / m / "*turn_*.png")))
    return [cv2.imread(f) for f in fs]
B = frames(base)
flows, masks = [], []
for a, b in zip(B, B[1:] + B[:1]):
    ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
    f = cv2.calcOpticalFlowFarneback(gb, ga, None, 0.5, 4, 21, 5, 7, 1.5, 0)   # for every pixel of b: where it was in a
    flows.append(f)
    bg = np.median(np.concatenate([a[:6, :6].reshape(-1, 3), a[-6:, -6:].reshape(-1, 3)]), 0)
    masks.append((np.abs(b.astype(int) - bg).sum(2) > 30) & (np.abs(a.astype(int) - bg).sum(2) > 30))
h, w = B[0].shape[:2]
gx, gy = np.meshgrid(np.arange(w), np.arange(h))
base_res = None
for m in [base] + models:
    F = frames(m); res = []
    for i, (a, b) in enumerate(zip(F, F[1:] + F[:1])):
        f = flows[i]
        wa = cv2.remap(a, (gx + f[..., 0]).astype(np.float32), (gy + f[..., 1]).astype(np.float32), cv2.INTER_LINEAR)
        d = np.abs(wa.astype(float) - b.astype(float)).mean(2)
        res.append(float(d[masks[i]].mean()))
    res = np.array(res)
    if base_res is None:
        base_res = res
    ex = res - base_res   # paint that moved, beyond what the consistent Pixal3D paint leaves
    print(json.dumps({"model": m, "residual": round(float(res.mean()), 2), "excess_mean": round(float(ex.mean()), 2),
                      "excess_p90": round(float(np.percentile(ex, 90)), 2), "excess_worst": round(float(ex.max()), 2),
                      "worst_at_deg": int(np.argmax(ex)) * (360 // len(F)) + (360 // len(F)) // 2}))
