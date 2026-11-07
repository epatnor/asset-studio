#!/bin/bash
# Andra ComfyUI på Quadro M4000 (Maxwell, sm_52): egen venv med torch cu126, port 8189, delar modeller och noder med den första
export CUDA_DEVICE_ORDER=PCI_BUS_ID  # samma numrering som nvidia-smi
export CUDA_VISIBLE_DEVICES=1
cd /data/ComfyUI
exec nice -n 5 /data/venv-m4000/bin/python main.py --listen 0.0.0.0 --port 8189 --input-directory /data/indata --output-directory /data/utdata   --temp-directory /data/ComfyUI/temp_m4000 --user-directory /data/ComfyUI/user_m4000   --database-url sqlite:////data/ComfyUI/user_m4000/comfyui.db --reserve-vram 1 --disable-cuda-malloc
