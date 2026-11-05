#!/bin/bash
# Installerar en användartimer på Andorhal som hämtar färdiga jobb från Darrowmere var tionde minut
# (deliver.py, till ~/Darrowmere-leveranser). Körs på Andorhal, utan sudo:
#   bash tools/darrowmere/install_delivery_timer.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
U=$HOME/.config/systemd/user
mkdir -p "$U"
cat > "$U/darrowmere-deliver.service" <<E
[Unit]
Description=Fetch finished Darrowmere jobs to ~/Darrowmere-leveranser

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 -I $HERE/deliver.py
E
cat > "$U/darrowmere-deliver.timer" <<'E'
[Unit]
Description=Fetch finished Darrowmere jobs every ten minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Persistent=true

[Install]
WantedBy=timers.target
E
systemctl --user daemon-reload
systemctl --user enable --now darrowmere-deliver.timer
systemctl --user list-timers darrowmere-deliver.timer --no-pager | head -2
