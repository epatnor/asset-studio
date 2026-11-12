"""Paint offset against Pixal3D: DIS flow between the Pixal3D render and a model's render at the same angle (same mesh and
camera, so any flow is paint that sits elsewhere). Median and p95 in px over the figure, at face angles."""
import json, sys, glob
import cv2, numpy as np
root, base, models = sys.argv[1], sys.argv[2], sys.argv[3:]
angles = (170, 190, 200, 210, 230)
def frame(m, d):
    return cv2.imread(sorted(glob.glob(f"{root}/{m}/*turn_*.png"))[d // 10])
for m in models:
    meds, p95s = [], []
    for d in angles:
        a, b = frame(base, d), frame(m, d)
        ga, gb = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY), cv2.cvtColor(b, cv2.COLOR_BGR2GRAY)
        bg = np.median(a[:6, :6].reshape(-1, 3), 0)
        mk = np.abs(a.astype(int) - bg).sum(2) > 30
        f = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM).calc(ga, gb, None)
        mag = np.linalg.norm(f, axis=2)[mk]
        meds.append(np.median(mag)); p95s.append(np.percentile(mag, 95))
    print(json.dumps({"model": m, "offset_median_px": round(float(np.mean(meds)), 2), "offset_p95_px": round(float(np.mean(p95s)), 2)}))
