#!/bin/bash
# Kopierar Darrowmeres kontrollpanel till Winterspring (som servar den) och startar om tjänsten.
# Första gången: bash ~/darrowmere-monitor/install_on_winterspring.sh på Winterspring.
#   bash tools/darrowmere/deploy.sh [värd]        (standard epatnor@192.168.0.17)
set -euo pipefail
H=${1:-epatnor@192.168.0.17}
cd "$(dirname "$0")"
rsync -a --mkpath monitor.py auth.py gallery.py gallery.html monitor.html viewer.html compare.html log.html history.html images.html login.html accounts.html settings.html static install_on_winterspring.sh "$H:darrowmere-monitor/"
ssh -o BatchMode=yes "$H" 'systemctl --user restart darrowmere-monitor.service && echo restarted || echo "not installed yet: run install_on_winterspring.sh"'
