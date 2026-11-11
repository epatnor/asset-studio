#!/bin/bash
# Kopierar Darrowmeres kontrollpanel till Winterspring (som servar den) och startar om tjänsten.
# Första gången: bash ~/darrowmere-monitor/install_on_winterspring.sh på Winterspring.
#   bash tools/darrowmere/deploy.sh [värd]        (standard epatnor@192.168.0.17)
set -euo pipefail
H=${1:-epatnor@192.168.0.17}
cd "$(dirname "$0")"
rsync -a --mkpath monitor.py auth.py gallery.py character_order.py machine.py machines.json make_app_icon.py character.html character gallery.html monitor.html viewer.html compare.html log.html history.html images.html login.html accounts.html settings.html static install_on_winterspring.sh "$H:darrowmere-monitor/"
# Every machine's panel (darrowmere-monitor, ravenholdt-monitor ...) runs this code: restart them all
ssh -o BatchMode=yes "$H" 'systemctl --user restart "*-monitor.service" && systemctl --user list-units --plain --no-legend "*-monitor.service" | cut -d" " -f1 || echo "not installed yet: run install_on_winterspring.sh"'
