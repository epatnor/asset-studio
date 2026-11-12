"""Sharpness: Laplacian variance over the figure at face angles (same frames as offset_metric)."""
import json, sys, glob
import cv2, numpy as np
root, models = sys.argv[1], sys.argv[2:]
for m in models:
    v = []
    for d in (170, 190, 200, 210, 230):
        a = cv2.imread(sorted(glob.glob(f"{root}/{m}/*turn_*.png"))[d // 10])
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(float)
        bg = np.median(a[:6, :6].reshape(-1, 3), 0)
        mk = cv2.erode((np.abs(a.astype(int) - bg).sum(2) > 30).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        v.append(cv2.Laplacian(g, cv2.CV_64F)[mk].var())
    print(json.dumps({"model": m, "sharpness": round(float(np.mean(v)), 1)}))
