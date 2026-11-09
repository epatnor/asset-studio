#!/bin/bash
# Försöker starta en RunPod-körning var tionde minut tills ett kort är ledigt (högst HOURS timmar), startar sedan vakten.
#   start_when_free.sh <run> '<startrecept>' [HOURS]
RUN=$1; REC=$2; HOURS=${3:-12}
cd /data/texverse/runpod; export ULTRATEX_RUNS=/data/texverse/runs PIPELINE_HOST=local
D=/data/texverse/runs/$RUN; mkdir -p $D; END=$(( $(date +%s) + HOURS * 3600 ))
while [ $(date +%s) -lt $END ]; do
    python3 -I runpod_train.py start "$REC" > $D/start.out 2>&1
    if grep -q '"ok": true' $D/start.out; then
        exec nice -n 10 python3 -I runpod_train.py watch "{\"run\": \"$RUN\"}" >> $D/watch.out 2>&1
    fi
    date "+%F %T no card" >> $D/waiting.log
    sleep 600
done
