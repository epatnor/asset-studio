#!/bin/bash
# Kopierar kontrollpanelen till Darrowmere och startar om den (efter att install_on_darrowmere.sh körts en gång).
#   bash tools/darrowmere/deploy.sh [värd]        (standard epatnor@192.168.0.33)
set -euo pipefail
H=${1:-epatnor@192.168.0.33}
cd "$(dirname "$0")"
rsync -a --mkpath monitor.py monitor.html viewer.html log.html history.html images.html install_on_darrowmere.sh "$H:/data/monitor/"
ssh -o BatchMode=yes "$H" 'sudo -n /usr/bin/systemctl restart darrowmere-monitor.service 2>/dev/null && echo restarted || echo "not installed yet: run install_on_darrowmere.sh with sudo"'
