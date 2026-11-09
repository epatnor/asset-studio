#!/bin/bash
# Väntar på omålningen (frost-sister-ut4b-r6) och graderar resultatet med gamma 1,3.
cd "$(dirname "$0")/../../.."; D=build/characters/frost_sister; DM=epatnor@192.168.0.33
until ssh -o BatchMode=yes -o ConnectTimeout=10 $DM "grep -q -E '^ \"status\": \"(done|failed|cancelled|rejected|stopped)' /data/orders/frost-sister-ut4b-r6/state.json" < /dev/null; do sleep 60; done
ssh -o BatchMode=yes $DM "grep -m1 '\"status\"' /data/orders/frost-sister-ut4b-r6/state.json" < /dev/null
F=$(ssh -o BatchMode=yes $DM "ls /data/utdata/characters/frost_sister/ | grep '^frost_sister_ut4b_.*glb$' | tail -1" < /dev/null)
[ -n "$F" ] || { echo "no repaint GLB"; exit 1; }
mkdir -p $D/ut4b; scp -q "$DM:/data/utdata/characters/frost_sister/$F" $D/ut4b/ < /dev/null
uv run -q --no-project --python 3.12 --with pillow --with numpy python -I tools/texture/grade_glb.py $D/ut4b/$F $D/ut4b/frost_sister_ut4b_g1.3.glb
scp -q $D/ut4b/frost_sister_ut4b_g1.3.glb $DM:/data/utdata/characters/frost_sister/ < /dev/null && echo "graded and uploaded: $F"
