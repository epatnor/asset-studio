#!/bin/bash
# Andra ComfyUI på Quadro M4000 som systemtjänst (port 8189). Körs en gång på Darrowmere: sudo bash install_comfy_m4000.sh
# Förutsätter /data/venv-m4000 (torch cu126, stöder Maxwell) och /data/runner/comfy_m4000.sh.
set -euo pipefail
cat > /etc/systemd/system/comfyui-m4000.service <<'E'
[Unit]
Description=ComfyUI on Quadro M4000 (second GPU, port 8189)
After=network-online.target comfyui.service

[Service]
User=epatnor
ExecStart=/data/runner/comfy_m4000.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
E
F=/etc/sudoers.d/comfyui-m4000
echo 'epatnor ALL=(root) NOPASSWD: /usr/bin/systemctl restart comfyui-m4000.service, /usr/bin/systemctl stop comfyui-m4000.service, /usr/bin/systemctl start comfyui-m4000.service' > $F.tmp
chmod 440 $F.tmp && visudo -cf $F.tmp && mv $F.tmp $F
pkill -u epatnor -f "main.py .*--port 8189" || true
# Kontrollpanelen på Winterspring läser jobben från port 8189, som 8188
if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q "Status: active"; then
  ufw allow from 192.168.0.0/24 to any port 8189 proto tcp comment "ComfyUI M4000" >/dev/null
fi
systemctl daemon-reload
systemctl enable --now comfyui-m4000.service
systemctl is-active comfyui-m4000.service
