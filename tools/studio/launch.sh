#!/bin/sh
# Asset Studio från appmenyn (~/.local/share/applications/asset-studio.desktop, installeras med
# tools/studio/install_launcher.sh). Körs på värden: startar studioservern om den inte svarar, som en systemd-enhet i
# containern claude-desktop, och ber den sedan öppna studion i ett eget fönster på det snabba grafikkortet (servern
# väljer kort och startar Chrome, se /api/gpu/launch i tools/studio/server.mjs). Går det inte öppnas studion i
# standardwebbläsaren.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT=8770
URL="http://localhost:$PORT"
up() { curl -fs -o /dev/null --max-time 2 "$URL/studio/"; }

if ! up; then
  notify-send -a "Asset Studio" -i asset-studio "Asset Studio" "Starting the studio server…" 2>/dev/null
  systemctl --user stop asset-studio-server 2>/dev/null
  systemctl --user reset-failed asset-studio-server 2>/dev/null
  systemd-run --user --unit=asset-studio-server --collect distrobox enter claude-desktop -- node "$ROOT/tools/studio/server.mjs" "$PORT"
  # Containern kan behöva startas först: vänta upp till 45 sekunder
  i=0
  while [ $i -lt 90 ] && ! up; do sleep 0.5; i=$((i + 1)); done
fi
if ! up; then
  notify-send -a "Asset Studio" -i dialog-error "Asset Studio" "The studio server did not start (journalctl --user -u asset-studio-server)" 2>/dev/null
  exit 1
fi
# Finns ett Asset Studio-fönster redan (klassen asset-studio, se --class i servern) lyfts det fram i stället för ett nytt
if command -v wmctrl >/dev/null && wmctrl -lx 2>/dev/null | grep -qi 'asset-studio'; then
  wmctrl -x -a asset-studio && exit 0
fi
curl -fs --max-time 10 -X POST -H 'content-type: application/json' -d '{"id":"discrete","path":"/studio/"}' "$URL/api/gpu/launch" | grep -q '"ok":true' \
  || xdg-open "$URL/studio/"
