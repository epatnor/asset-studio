#!/bin/bash
# Väntar på konceptet (frost-sister-r1), beställer UltraTex-omålningen och graderar resultatet (gamma 1,3).
cd "$(dirname "$0")/../../.."; D=build/characters/frost_sister; DM=epatnor@192.168.0.33
done_() { ssh -o BatchMode=yes -o ConnectTimeout=10 $DM "grep -q -E '^ \"status\": \"(done|failed|cancelled)\"' /data/orders/$1/state.json" < /dev/null; }
until done_ frost-sister-r1; do sleep 60; done
ST=$(ssh -o BatchMode=yes $DM "python3 -c \"import json; s=json.load(open('/data/orders/frost-sister-r1/state.json')); print(s['status']); print([f['filename'] for f in s['steps']['img_1'].get('outputs',[])][-1]); print(sorted(f['filename'] for f in s['steps']['mesh'].get('outputs',[]) if f['filename'].endswith('.glb'))[-1])\"" < /dev/null)
echo "$ST"; IMG=$(echo "$ST" | sed -n 2p); GLB=$(echo "$ST" | sed -n 3p)
mkdir -p $D/img $D/ut4b; scp -q "$DM:/data/utdata/characters/frost_sister/*.png" $D/img/ < /dev/null
python3 -I $D/make_texture_order.py "/data/utdata/3d/characters/$GLB" "$D/img/$IMG" && python3 -I tools/darrowmere/order.py submit $D/texture_order.json
until done_ frost-sister-ut4b; do sleep 60; done
F=$(ssh -o BatchMode=yes $DM "ls /data/utdata/characters/frost_sister/ | grep '^frost_sister_ut4b_.*glb$' | tail -1" < /dev/null)
scp -q "$DM:/data/utdata/characters/frost_sister/$F" $D/ut4b/ < /dev/null
uv run -q --no-project --python 3.12 --with pillow --with numpy python -I tools/texture/grade_glb.py $D/ut4b/$F $D/ut4b/frost_sister_ut4b_g1.3.glb
scp -q $D/ut4b/frost_sister_ut4b_g1.3.glb $DM:/data/utdata/characters/frost_sister/ < /dev/null && echo "graded and uploaded"
