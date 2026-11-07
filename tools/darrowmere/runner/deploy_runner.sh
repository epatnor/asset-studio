#!/bin/bash
# Kopierar beställningsrunnern till Darrowmere (/data/runner) och startar om tjänsten om den finns.
# OpenRouter-nyckeln kopieras första gången från apparition-moodboard/.env, utan att skrivas ut. Körs på Andorhal:
#   bash tools/darrowmere/runner/deploy_runner.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DM=epatnor@192.168.0.33
ENV=$HOME/Spelutveckling/apparition-moodboard/.env
ssh -o BatchMode=yes $DM 'mkdir -p /data/runner /data/orders/inbox'
rsync -a "$HERE/runner.py" "$HERE/runner.json" "$HERE/render_views.py" "$HERE/install_runner.sh" "$HERE/install_comfy_m4000.sh" "$HERE/comfy_m4000.sh" $DM:/data/runner/
rsync -a "$HERE/tools/" $DM:/data/runner/tools/
rsync -a "$HERE/playbooks/" $DM:/data/runner/playbooks/
rsync -a "$HERE/../../texture/project_views.py" $DM:/data/runner/tools/project_views.py
if ! ssh -o BatchMode=yes $DM 'test -s /data/runner/.env'; then
  grep '^OPENROUTER_API_KEY=' "$ENV" | ssh -o BatchMode=yes $DM 'umask 077; cat > /data/runner/.env'
  echo "key copied"
fi
ssh -o BatchMode=yes $DM 'chmod 600 /data/runner/.env; systemctl is-active --quiet darrowmere-runner && sudo -n /usr/bin/systemctl restart darrowmere-runner.service && echo restarted || echo "service not installed yet"'
