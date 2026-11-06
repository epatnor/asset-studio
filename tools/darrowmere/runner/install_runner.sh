#!/bin/bash
# Installerar beställningsrunnern som systemtjänst på Darrowmere (startar vid uppstart, efter ComfyUI).
# Körs på Darrowmere med sudo, efter deploy_runner.sh:
#   ssh -t epatnor@192.168.0.33 'sudo bash /data/runner/install_runner.sh'
set -euo pipefail
cat > /etc/systemd/system/darrowmere-runner.service <<'E'
[Unit]
Description=Darrowmere order runner (pipelines, ComfyUI steps, DeepSeek reviews)
After=network-online.target comfyui.service
Wants=network-online.target

[Service]
User=epatnor
WorkingDirectory=/data/runner
ExecStart=/data/venv/bin/python -I /data/runner/runner.py
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
E
# Panelen och deploy_runner.sh får starta om tjänsten utan lösenord, som för ComfyUI
echo 'epatnor ALL=(root) NOPASSWD: /usr/bin/systemctl restart darrowmere-runner.service, /usr/bin/systemctl stop darrowmere-runner.service, /usr/bin/systemctl start darrowmere-runner.service' > /etc/sudoers.d/darrowmere-runner
chmod 440 /etc/sudoers.d/darrowmere-runner
visudo -cf /etc/sudoers.d/darrowmere-runner
systemctl daemon-reload
systemctl enable --now darrowmere-runner.service
systemctl is-active darrowmere-runner.service
