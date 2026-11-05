#!/bin/bash
# Installerar kontrollpanelen som tjänst på Darrowmere. Körs på Darrowmere med sudo, en gång:
#   ssh -t epatnor@192.168.0.33 'sudo bash /data/monitor/install_on_darrowmere.sh'
# Filerna kopieras först till /data/monitor (se tools/darrowmere/deploy.sh). Därefter räcker deploy.sh för uppdateringar.
set -euo pipefail
DIR=/data/monitor
PORT=8790

cat > /etc/systemd/system/darrowmere-monitor.service <<E
[Unit]
Description=Darrowmere control panel (jobs and machine health)
After=network-online.target comfyui.service
Wants=network-online.target
RequiresMountsFor=/data

[Service]
User=epatnor
Group=epatnor
WorkingDirectory=$DIR
Environment=DARROWMERE_HOST=localhost
Environment=DARROWMERE_COMFY=http://127.0.0.1:8188
Environment=MONITOR_BIND=0.0.0.0
Environment=MONITOR_STATE=$DIR/jobs.json
ExecStart=/usr/bin/python3 -I $DIR/monitor.py $PORT
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
E

# Låt epatnor starta om panelen utan lösenord när den uppdateras
F=/etc/sudoers.d/darrowmere-monitor
echo 'epatnor ALL=(root) NOPASSWD: /usr/bin/systemctl restart darrowmere-monitor.service' > $F.tmp
chmod 440 $F.tmp
visudo -cf $F.tmp >/dev/null && mv $F.tmp $F

if command -v ufw >/dev/null && LC_ALL=C ufw status | grep -q "Status: active"; then
  ufw allow from 192.168.0.0/24 to any port $PORT proto tcp comment "Darrowmere control panel" >/dev/null
fi

systemctl daemon-reload
systemctl enable --now darrowmere-monitor.service
sleep 2
systemctl is-active darrowmere-monitor.service
echo "Panel: http://$(hostname -I | awk '{print $1}'):$PORT"
