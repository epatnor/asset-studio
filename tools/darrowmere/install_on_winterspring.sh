#!/bin/bash
# Installs a worker machine's control panel as a user service on Winterspring, which is always on.
# The panel reads the machine over SSH (key ~/.ssh/id_ed25519_darrowmere) and its ComfyUI over the home network,
# and shows "offline" when the machine is off or asleep. Run on Winterspring, without sudo:
#   bash ~/darrowmere-monitor/install_on_winterspring.sh                     Darrowmere on port 8790
#   bash ~/darrowmere-monitor/install_on_winterspring.sh ravenholdt 8791     Ravenholdt on port 8791
# Every panel runs the same code in ~/darrowmere-monitor (deploy.sh); the machine comes from machines.json.
# A new panel starts with the Darrowmere panel's accounts (users.json is copied once).
set -euo pipefail
DIR=$HOME/darrowmere-monitor
M=${1:-darrowmere}
PORT=${2:-8790}
SHOW=$(python3 -I $DIR/machine.py show $M)
WH=$(echo "$SHOW" | python3 -c 'import json,sys; print(json.load(sys.stdin)["host"])')
NAME=$(echo "$M" | python3 -c 'import sys; print(sys.stdin.read().strip().capitalize())')
LANES=$(echo "$SHOW" | python3 -c 'import json,sys; m=json.load(sys.stdin); print(json.dumps(m.get("lanes") or {"T1000": "http://%s:8188" % m["host"]}))')
SCALE=$(echo "$SHOW" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("wordmark_scale", 1))')
STATE=$HOME/.local/state/$M-monitor
UNIT=$M-monitor.service
mkdir -p ~/.config/systemd/user "$STATE"
if [ "$M" != darrowmere ] && [ ! -e "$STATE/users.json" ] && [ -e ~/.local/state/darrowmere-monitor/users.json ]; then
  cp -p ~/.local/state/darrowmere-monitor/users.json "$STATE/users.json"
fi
cat > ~/.config/systemd/user/$UNIT <<E
[Unit]
Description=$NAME control panel (jobs and machine health), served from Winterspring
After=network-online.target

[Service]
WorkingDirectory=$DIR
Environment=MONITOR_NAME=$NAME
Environment=DARROWMERE_WORKER=$M
Environment=DARROWMERE_HOST=$WH
Environment=DARROWMERE_COMFY=http://$WH:8188
Environment='DARROWMERE_COMFY_LANES=$LANES'
Environment=MONITOR_WORDMARK_SCALE=$SCALE
Environment=MONITOR_SSH_KEY=%h/.ssh/id_ed25519_darrowmere
Environment=MONITOR_BIND=0.0.0.0
Environment=MONITOR_STATE=$STATE/jobs.json
ExecStart=/usr/bin/python3 -I $DIR/monitor.py $PORT
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
E
systemctl --user daemon-reload
systemctl --user enable --now $UNIT
systemctl --user restart $UNIT
sleep 2
systemctl --user is-active $UNIT
echo "Panel: http://$(hostname -I | awk '{print $1}'):$PORT"
