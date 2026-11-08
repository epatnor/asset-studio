#!/bin/bash
# Provkörning av UltraTex 4B på en hyrd H100 (docs/ultratex-4b.md, steg 2). Körs PÅ poden av runpod_smoke.py.
# Hämtar bara öppet licensierade delar: Klein base 4B + Qwen3 4B (BFL, Apache), FLUX.2-VAE:n (Comfy-Org, Apache),
# UltraTex-koden (MIT) och en bucket G-buffer TexVerse (CC0). UltraTex:s NC-vikter (LoRA, decoder.pt) hämtas inte:
# dekodern för valideringen tas ur bas-VAE:n.
# Faserna skrivs till /workspace/phases.jsonl, GPU-minnet till gpu.csv och träningen till train.log.
set -uo pipefail
W=/workspace; mkdir -p $W; cd $W
ph() { echo "{\"phase\": \"$1\", \"t\": $(date +%s)}" >> $W/phases.jsonl; }
fail() { ph "failed:$1"; exit 1; }

# ssh-sessioner ärver inte containerns miljö: hämta RUNPOD_POD_ID och den pod-bundna nyckeln från process 1
while IFS= read -r -d '' kv; do case $kv in RUNPOD_*) export "$kv";; esac; done < /proc/1/environ
# Vakthund: poden tas bort efter MAX_MIN minuter vad som än händer (laptopen kan sova)
( sleep $(( ${MAX_MIN:-150} * 60 )); ph watchdog; runpodctl remove pod "$RUNPOD_POD_ID" ) >/dev/null 2>&1 &
nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader,nounits -l 5 > $W/gpu.csv 2>/dev/null &

ph setup
pip install -q uv || fail uv
[ -d UltraTex ] || git clone -q https://github.com/yiboz2001/UltraTex.git || fail clone
cd UltraTex && git checkout -q a726678 || fail checkout
[ -x .venv/bin/python ] || uv venv -q -p 3.12 .venv || fail venv
grep -v '^deepspeed' requirements.txt > $W/req.txt          # deepspeed används inte av train_flux2.py
uv pip install -q -p .venv/bin/python --index-strategy unsafe-best-match -r $W/req.txt > $W/pip.log 2>&1 || fail pip
uv pip install -q -p .venv/bin/python typer click hf_xet >> $W/pip.log 2>&1 || fail pip_cli   # för hf-kommandot
HF=$PWD/.venv/bin/hf

ph download
M=$W/models/flux2; mkdir -p $M/qwen3-4b
$HF download YiboZhang2001/G-buffer-TexVerse --repo-type dataset --include canonical/bsdf/00.zip \
    --local-dir $W/texverse > $W/dl_data.log 2>&1 &
DL=$!
$HF download black-forest-labs/FLUX.2-klein-base-4B flux-2-klein-base-4b.safetensors --local-dir $W/hf/klein4b > $W/dl_model.log 2>&1 || fail dl_klein
$HF download black-forest-labs/FLUX.2-klein-base-4B --include 'text_encoder/*' 'tokenizer/*' \
    --local-dir $W/hf/klein4b >> $W/dl_model.log 2>&1 || fail dl_qwen
$HF download Comfy-Org/Flux-2-Klein-4B --include split_files/vae/flux2-vae.safetensors \
    --local-dir $W/hf/comfy >> $W/dl_model.log 2>&1 || fail dl_vae
ln -sf $W/hf/klein4b/flux-2-klein-base-4b.safetensors $M/
ln -sf $W/hf/comfy/split_files/vae/flux2-vae.safetensors $M/ae.safetensors
ln -sf $W/hf/klein4b/text_encoder/* $W/hf/klein4b/tokenizer/* $M/qwen3-4b/
# Dekoder för valideringen: bas-VAE:ns egen dekoder (inte UltraTex:s NC-dekoder)
.venv/bin/python -c "
import torch; from safetensors.torch import load_file
s = load_file('$M/ae.safetensors')
torch.save({k[8:]: v for k, v in s.items() if k.startswith('decoder.')}, '$W/decoder_base.pt')" || fail decoder
wait $DL || fail dl_data

ph prep
.venv/bin/python -I $W/prep_texverse.py "{\"buckets\": [\"$W/texverse/canonical/bsdf/00.zip\"], \"out\": \"$W/extracted\", \"eval_n\": 2, \"limit\": ${LIMIT:-300}}" \
    > $W/prep.json 2>&1 || fail prep
rm -f $W/texverse/canonical/bsdf/00.zip

ph train
export FLUX2_CACHE=$M RESOLUTION=${RESOLUTION:-1024} MAX_TRAIN_STEPS=${STEPS:-200} CHECKPOINTING_STEPS=100000 \
    RESUME_FROM_CHECKPOINT= DECODER_CKPT=$W/decoder_base.pt \
    TRAIN_JSON=$W/extracted/train.json EVAL_JSON=$W/extracted/eval.json BUCKET_METADATA_JSON=$W/extracted/foreground_ratios.json \
    WORKERS_PER_GPU=$(( $(nproc) > 14 ? 12 : $(nproc) - 2 )) PROJECT_DIR=$W/out
bash scripts/train_flux2_9b_2048.sh 4b > $W/train.log 2>&1 || fail train
ph done
