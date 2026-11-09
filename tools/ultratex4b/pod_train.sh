#!/bin/bash
# UltraTex 4B-träning på en hyrd H100 (docs/ultratex-4b.md, steg 2–3). Körs PÅ poden av runpod_train.py.
# Hämtar bara öppet licensierade delar: Klein base 4B + Qwen3 4B (BFL, Apache), FLUX.2-VAE:n (Comfy-Org, Apache),
# UltraTex-koden (MIT) och G-buffer TexVerse (CC0). UltraTex:s NC-vikter (LoRA, decoder.pt) hämtas inte:
# dekodern för valideringen tas ur bas-VAE:n.
# Miljö: JOB (lora eller decoder: UltraTex-dekodern, scripts/train_vae_flux2.sh, bara VAE:n behövs), INIT (checkpoint att fortsätta från), BUCKETS ("00 01 ..."), LIMIT (0 = alla objekt), EVAL_N, STEPS, CKPT_STEPS (validering), RESOLUTION, MAX_MIN, GRACE_MIN.
# Faserna skrivs till /workspace/phases.jsonl, GPU-minnet till gpu.csv och träningen till train.log.
set -uo pipefail
W=/workspace; mkdir -p $W; cd $W
ph() { echo "{\"phase\": \"$1\", \"t\": $(date +%s)}" >> $W/phases.jsonl; }
fail() { ph "failed:$1"; exit 1; }

# ssh-sessioner ärver inte containerns miljö: hämta RUNPOD_POD_ID och den pod-bundna nyckeln från process 1
while IFS= read -r -d '' kv; do case $kv in RUNPOD_*) export "$kv";; esac; done < /proc/1/environ
# Vakthund: poden STOPPAS (GPU:n släpps, disken med checkpoints finns kvar) efter MAX_MIN minuter vad som än händer
( sleep $(( ${MAX_MIN:-150} * 60 )); ph watchdog; runpodctl stop pod "$RUNPOD_POD_ID" ) >/dev/null 2>&1 &
nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits -l 5 > $W/gpu.csv 2>/dev/null &

ph setup
pip install -q uv || fail uv
[ -d UltraTex ] || git clone -q https://github.com/yiboz2001/UltraTex.git || fail clone
cd UltraTex && git checkout -q a726678 || fail checkout
[ -x .venv/bin/python ] || uv venv -q -p 3.12 .venv || fail venv
grep -v '^deepspeed' requirements.txt > $W/req.txt          # deepspeed används inte av train_flux2.py
uv pip install -q -p .venv/bin/python --index-strategy unsafe-best-match -r $W/req.txt > $W/pip.log 2>&1 || fail pip
uv pip install -q -p .venv/bin/python typer click hf_xet >> $W/pip.log 2>&1 || fail pip_cli   # för hf-kommandot
if [ "${JOB:-lora}" = decoder ]; then   # dekoderträningen går via DeepSpeed (ZeRO 2)
    uv pip install -q -p .venv/bin/python "$(grep '^deepspeed' requirements.txt)" >> $W/pip.log 2>&1 || fail pip_deepspeed
fi
HF=$PWD/.venv/bin/hf

ph download
M=$W/models/flux2; mkdir -p $M/qwen3-4b
BUCKETS=${BUCKETS:-00}; ZIPS=(); DLP=()
for b in $BUCKETS; do
    ZIPS+=("$W/texverse/canonical/bsdf/$b.zip")
    $HF download YiboZhang2001/G-buffer-TexVerse canonical/bsdf/$b.zip --repo-type dataset \
        --local-dir $W/texverse > $W/dl_data_$b.log 2>&1 &
    DLP+=($!)
done
if [ "${JOB:-lora}" != decoder ]; then
$HF download black-forest-labs/FLUX.2-klein-base-4B flux-2-klein-base-4b.safetensors --local-dir $W/hf/klein4b > $W/dl_model.log 2>&1 || fail dl_klein
$HF download black-forest-labs/FLUX.2-klein-base-4B --include 'text_encoder/*' --include 'tokenizer/*' \
    --local-dir $W/hf/klein4b >> $W/dl_model.log 2>&1 || fail dl_qwen
fi
$HF download Comfy-Org/Flux-2-Klein-4B split_files/vae/flux2-vae.safetensors \
    --local-dir $W/hf/comfy >> $W/dl_model.log 2>&1 || fail dl_vae
ln -sf $W/hf/klein4b/flux-2-klein-base-4b.safetensors $M/
ln -sf $W/hf/comfy/split_files/vae/flux2-vae.safetensors $M/ae.safetensors
ln -sf $W/hf/klein4b/text_encoder/* $W/hf/klein4b/tokenizer/* $M/qwen3-4b/
[ -s $M/ae.safetensors ] || fail models_missing
[ "${JOB:-lora}" = decoder ] || { [ -s $M/flux-2-klein-base-4b.safetensors ] && [ -s $M/qwen3-4b/config.json ]; } || fail models_missing
# Dekoder för valideringen: bas-VAE:ns egen dekoder (inte UltraTex:s NC-dekoder)
.venv/bin/python -c "
import torch; from safetensors.torch import load_file
s = load_file('$M/ae.safetensors')
torch.save({k[8:]: v for k, v in s.items() if k.startswith('decoder.')}, '$W/decoder_base.pt')" || fail decoder
for p in "${DLP[@]}"; do wait $p; done      # bara nedladdningarna (vakthunden och nvidia-smi körs vidare)
for z in "${ZIPS[@]}"; do [ -s "$z" ] || fail "dl_data_$(basename $z .zip)"; done

ph prep
JZ=$(printf '"%s",' "${ZIPS[@]}"); JZ="[${JZ%,}]"
.venv/bin/python -I $W/prep_texverse.py "{\"buckets\": $JZ, \"out\": \"$W/extracted\", \"eval_n\": ${EVAL_N:-2}, \"limit\": ${LIMIT:-0}, \"delete_zips\": true}" \
    > $W/prep.json 2>&1 || fail prep

ph train
if [ "${JOB:-lora}" = decoder ]; then
    # Bara dekodern tränas (VAE:ns kodare fryst), mot albedon; färgfelet (deltaE 2000) mäts på eval-objekten var 1000:e steg
    AE_MODEL_PATH=$M/ae.safetensors TRAIN_JSON=$W/extracted/train.json EVAL_JSON=$W/extracted/eval.json OUTPUT_DIR=$W/out \
        RESOLUTION=${RESOLUTION:-1024} MAX_TRAIN_STEPS=${STEPS:-200} SAVE_EVERY=${CKPT_STEPS:-500} MODEL_NAME=flux.2-klein-base-4b MAIN_PROCESS_PORT=29500 \
        NUM_WORKERS=${DEC_WORKERS:-2} NUM_GPUS=1 \
        bash scripts/train_vae_flux2.sh >> $W/train.log 2>&1 || fail train
else
export FLUX2_CACHE=$M RESOLUTION=${RESOLUTION:-1024} MAX_TRAIN_STEPS=${STEPS:-200} CHECKPOINTING_STEPS=${CKPT_STEPS:-100000} \
    RESUME_FROM_CHECKPOINT= DECODER_CKPT=$W/decoder_base.pt \
    TRAIN_JSON=$W/extracted/train.json EVAL_JSON=$W/extracted/eval.json BUCKET_METADATA_JSON=$W/extracted/foreground_ratios.json \
    WORKERS_PER_GPU=$(( $(nproc) > 14 ? 12 : $(nproc) - 2 )) PROJECT_DIR=$W/out
# Fortsätt från senaste checkpoint om poden har startats om (skriptet letar själv i PROJECT_DIR)
# INIT: en checkpoint från en tidigare körning (laddas upp av runpod_train.py), t.ex. /workspace/init/checkpoint-10000.
# Skriptet läser LoRA:n och fortsätter räkna steg därifrån; STEPS är då det totala målet (15000 = 5000 till)
[ -n "${INIT:-}" ] && export RESUME_FROM_CHECKPOINT=$INIT
ls -d $W/out/checkpoint-* >/dev/null 2>&1 && unset RESUME_FROM_CHECKPOINT
# LR: inlärningstakten (skriptets standard 5e-5); EXTRA: fler argument till train_flux2.py, t.ex. "--ema True --ema_decay 0.999"
export LEARNING_RATE=${LR:-5e-5}
unset TASK   # UltraTex-skriptet läser TASK (albedo/mr) själv; standard albedo
bash scripts/train_flux2_9b_2048.sh 4b ${EXTRA:-} >> $W/train.log 2>&1 || fail train
fi
ph done

# Vänta på att vakten hämtar resultatet (den skriver /workspace/fetched); annars stoppa poden så att disken finns kvar
for i in $(seq $(( ${GRACE_MIN:-120} * 2 ))); do [ -f $W/fetched ] && exit 0; sleep 30; done
ph grace_stop; runpodctl stop pod "$RUNPOD_POD_ID"
