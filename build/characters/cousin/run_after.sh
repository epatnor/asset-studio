#!/bin/bash
# Kusinen: väntar på konceptet (cousin-r1), beställer UltraTex-omålningen på Pixal3D-modellen (samma upplägg som frostsysterns
# r6b: steg 8000, bas-dekodern, vyvikt 8, 45°- och uppifrån-grupper utan deras topp/botten-vyer, två bakningar), graderar
# (gamma 1,3) och speglar ansiktet (den symmetriska A-posen gör speglingen möjlig).
cd "$(dirname "$0")/../../.."; D=build/characters/cousin; DM=epatnor@192.168.0.33; C=${CONCEPT:-cousin-r6}
done_() { ssh -o BatchMode=yes -o ConnectTimeout=10 $DM "grep -q -E '^ \"status\": \"(done|failed|cancelled|rejected|stopped)' /data/orders/$1/state.json" < /dev/null; }
until done_ $C; do sleep 60; done
ST=$(ssh -o BatchMode=yes $DM "python3 -c \"import json; s=json.load(open('/data/orders/$C/state.json')); print(s['status']); print([f['filename'] for f in s['steps']['img_1'].get('outputs',[])][-1]); print(sorted(f['filename'] for f in s['steps']['mesh'].get('outputs',[]) if f['filename'].endswith('.glb'))[-1])\"" < /dev/null)
echo "$ST"; IMG=$(echo "$ST" | sed -n 2p); GLB=$(echo "$ST" | sed -n 3p)
case "$(echo "$ST" | sed -n 1p)" in done*) ;; *) echo "concept did not finish: no repaint"; exit 1;; esac
[ -n "$GLB" ] || { echo "no model from Pixal3D"; exit 1; }
mkdir -p $D/img $D/ut4b; scp -q "$DM:/data/utdata/characters/cousin/$IMG" $D/img/ < /dev/null
python3 -I - "$GLB" "$D/img/$IMG" <<'PY'
import json, sys
from pathlib import Path
glb, ref = sys.argv[1], sys.argv[2]
o = json.load(open("build/characters/frost_sister/texture_order_r6b.json"))
g = o["steps"][0]["graph"]
g["22"]["inputs"]["glb_path"] = f"/data/utdata/3d/characters/{glb}"
for nid, pre in (("26", "ut4b_albedo_views"), ("42", "ut4b_albedo_views_2"), ("12", "cousin_ut4b_mix07"), ("13", "cousin_ut4b_mix09")):
    g[nid]["inputs"]["filename_prefix"] = f"characters/cousin/{pre}"
o.update(id="cousin-ut4b-r6", title="Cousin repainted: UltraTex 4B step 8000, base decoder, view weight 8, 45° + above rigs without top/bottom",
         asset="cousin", mission="cousin", mission_title="The sorceress's cousin: smooth swimsuit body in A-pose", inputs={"ref.png": str(Path(ref).resolve())})
Path("build/characters/cousin/texture_order.json").write_text(json.dumps(o, indent=1))
PY
python3 -I tools/darrowmere/order.py submit $D/texture_order.json
until done_ cousin-ut4b-r6; do sleep 60; done
for t in mix07 mix09; do
  F=$(ssh -o BatchMode=yes $DM "ls /data/utdata/characters/cousin/ | grep '^cousin_ut4b_${t}_.*glb$' | tail -1" < /dev/null)
  [ -n "$F" ] || { echo "missing $t"; continue; }
  scp -q "$DM:/data/utdata/characters/cousin/$F" $D/ut4b/ < /dev/null
  uv run -q --no-project --python 3.12 --with pillow --with numpy python -I tools/texture/grade_glb.py $D/ut4b/$F $D/ut4b/cousin_ut4b_${t}_g1.3.glb > /dev/null
  uv run -q --no-project --python 3.12 --with trimesh --with numpy --with pillow --with scipy --with rtree python -I tools/texture/mirror_face.py "{\"in\": \"$D/ut4b/cousin_ut4b_${t}_g1.3.glb\", \"out\": \"$D/ut4b/cousin_ut4b_${t}_g1.3_mirror.glb\"}"
  # Spelmodellen: 12 000 trianglar med färg och normalkarta bakade från högpolyversionen (fina voxlar, så att tunna delar
  # som öron och fingrar blir kvar)
  python3 -I tools/mesh/make_low.py "{\"high\": \"$D/ut4b/cousin_ut4b_${t}_g1.3_mirror.glb\", \"out\": \"$D/ut4b/low/cousin_low_12k_${t}.glb\", \"tris\": 12000, \"tex\": 2048, \"voxel\": 0.0035}"
  scp -q $D/ut4b/cousin_ut4b_${t}_g1.3.glb $D/ut4b/cousin_ut4b_${t}_g1.3_mirror.glb $D/ut4b/low/cousin_low_12k_${t}.glb $DM:/data/utdata/characters/cousin/ < /dev/null && echo "done $t"
done
