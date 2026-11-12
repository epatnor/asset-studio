#!/bin/bash
# Usage on Darrowmere: turntable.sh <out_root> <label> <glb> ; 36 head shots, 10 degrees apart, textured, 320 px
set -e
OUT=$1/$2; mkdir -p $OUT
JOB=$(python3 -c "
import json, sys
shots = [{'name': f'turn_{y:03d}', 'yaw': y, 'pitch': 5, 'zoom': 5.5, 'height': 0.925, 'mode': 'texture', 'size': 320} for y in range(0, 360, 10)]
print(json.dumps({'glb': sys.argv[1], 'out_dir': sys.argv[2], 'shots': shots, 'front_yaw': 90, 'stats': False}))" "$3" "$OUT")
nice -n 15 /data/blender/current/blender -b --factory-startup -P /data/runner/render_views.py -- --json "$JOB" 2>&1 | grep RENDER_RESULT | cut -c1-120
