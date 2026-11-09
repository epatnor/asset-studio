#!/bin/bash
# Väntar på omkörningen utan de extra vyerna rakt uppifrån (frost-sister-ut4b-r6b) och gör båda bakningarna klara:
# gradering gamma 1,3 och spegling av det lyckade ögat (tools/texture/mirror_face.py).
cd "$(dirname "$0")/../../.."; D=build/characters/frost_sister/ut4b; DM=epatnor@192.168.0.33
until ssh -o BatchMode=yes -o ConnectTimeout=10 $DM "grep -q -E '^ \"status\": \"(done|failed|cancelled|rejected|stopped)' /data/orders/frost-sister-ut4b-r6b/state.json" < /dev/null; do sleep 60; done
for t in notop_mix07 notop_mix09; do
  F=$(ssh -o BatchMode=yes $DM "ls /data/utdata/characters/frost_sister/ | grep '^frost_sister_ut4b_${t}_.*glb$' | tail -1" < /dev/null)
  [ -n "$F" ] || { echo "missing $t"; continue; }
  scp -q "$DM:/data/utdata/characters/frost_sister/$F" $D/ < /dev/null
  uv run -q --no-project --python 3.12 --with pillow --with numpy python -I tools/texture/grade_glb.py $D/$F $D/frost_sister_ut4b_${t}_g1.3.glb > /dev/null
  uv run -q --no-project --python 3.12 --with trimesh --with numpy --with pillow --with scipy --with rtree python -I tools/texture/mirror_face.py "{\"in\": \"$D/frost_sister_ut4b_${t}_g1.3.glb\", \"out\": \"$D/frost_sister_ut4b_${t}_g1.3_mirror.glb\"}"
  scp -q $D/frost_sister_ut4b_${t}_g1.3_mirror.glb $DM:/data/utdata/characters/frost_sister/ < /dev/null && echo "done $t"
done
