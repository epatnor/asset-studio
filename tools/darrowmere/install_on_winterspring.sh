#!/bin/bash
# Installerar Darrowmeres kontrollpanel som användartjänst på Winterspring, som alltid är igång.
# Panelen läser Darrowmere över SSH (nyckeln ~/.ssh/id_ed25519_darrowmere) och ComfyUI över hemmanätet,
# och visar "offline" när Darrowmere är avstängd. Körs på Winterspring, utan sudo:
#   bash ~/darrowmere-monitor/install_on_winterspring.sh
set -euo pipefail
DIR=$HOME/darrowmere-monitor
PORT=8790
# The worker's address comes from machines.json (copied here by deploy.sh); "worker" there picks the machine
WH=$(python3 -I $DIR/machine.py show | python3 -c 'import json,sys; print(json.load(sys.stdin)["host"])')
mkdir -p ~/.config/systemd/user ~/.local/state/darrowmere-monitor
cat > ~/.config/systemd/user/darrowmere-monitor.service <<E
[Unit]
Description=Darrowmere control panel (jobs and machine health), served from Winterspring
After=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=DARROWMERE_HOST=$WH
Environment=DARROWMERE_COMFY=http://$WH:8188
Environment=MONITOR_SSH_KEY=%h/.ssh/id_ed25519_darrowmere
Environment=MONITOR_BIND=0.0.0.0
Environment=MONITOR_STATE=%h/.local/state/darrowmere-monitor/jobs.json
ExecStart=/usr/bin/python3 -I $DIR/monitor.py $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
E
systemctl --user daemon-reload
systemctl --user enable --now darrowmere-monitor.service
sleep 2
systemctl --user is-active darrowmere-monitor.service
echo "Panel: http://$(hostname -I | awk '{print $1}'):$PORT"
