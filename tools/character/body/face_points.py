"""Hittar MediaPipes 478 ansiktspunkter i en bild. JSON in: {"img": "...", "out": "punkter.json"}. Skriver pixlar och relativt djup, och en rad JSON."""
import json, sys

import cv2
import mediapipe as mp
import numpy as np

r = json.loads(sys.argv[1])
im = cv2.cvtColor(cv2.imread(r["img"]), cv2.COLOR_BGR2RGB)
h, w = im.shape[:2]
with mp.solutions.face_mesh.FaceMesh(static_image_mode=True, max_num_faces=1, refine_landmarks=True, min_detection_confidence=0.2) as fm:
    res = fm.process(im)
if not res.multi_face_landmarks:
    print(json.dumps({"found": False, "img": r["img"]}))
    sys.exit(0)
pts = np.array([[p.x * w, p.y * h, p.z * w] for p in res.multi_face_landmarks[0].landmark])
json.dump({"size": [w, h], "pts": pts.round(2).tolist()}, open(r["out"], "w"))
L = {"iris_l": 468, "iris_r": 473, "mouth_l": 61, "mouth_r": 291, "chin": 152, "nose": 1, "brow_mid": 9, "jaw_l": 172, "jaw_r": 397}
print(json.dumps({"found": True, "n": len(pts), "key_px": {k: pts[i][:2].round(1).tolist() for k, i in L.items()}}))
