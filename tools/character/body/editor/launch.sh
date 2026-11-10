#!/bin/sh
# Body Editor från skrivbordet (installeras med tools/character/body/editor/install_launcher.sh). Körs på värden: startar editorns
# server om den inte svarar och öppnar editorn i ett eget Chrome-fönster på det snabba grafikkortet. Finns fönstret redan
# lyfts det fram. Går Chrome inte att starta öppnas editorn i standardwebbläsaren.
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"   # asset-studio
BODY="$ROOT/build/body"                            # arbetsytan (build/, out/, images/, .venv)
PORT="${BODY_EDITOR_PORT:-8772}"
URL="http://127.0.0.1:$PORT/"
ICON="$ROOT/tools/character/body/editor/icon.png"
up() { curl -fs -o /dev/null --max-time 2 "$URL"; }

if ! up; then
  notify-send -a "Body Editor" -i "$ICON" "Body Editor" "Starting the editor…" 2>/dev/null
  systemctl --user stop body-editor-server 2>/dev/null
  systemctl --user reset-failed body-editor-server 2>/dev/null
  systemd-run --user --unit=body-editor-server --collect --working-directory="$BODY" "$BODY/.venv/bin/python" "$ROOT/tools/character/body/editor/server.py" "$PORT"
  i=0
  while [ $i -lt 40 ] && ! up; do sleep 0.5; i=$((i + 1)); done
fi
if ! up; then
  notify-send -a "Body Editor" -i dialog-error "Body Editor" "The editor did not start (journalctl --user -u body-editor-server)" 2>/dev/null
  exit 1
fi
if command -v wmctrl >/dev/null && wmctrl -lx 2>/dev/null | grep -qi 'body-editor'; then
  wmctrl -x -a body-editor && exit 0
fi
env __NV_PRIME_RENDER_OFFLOAD=1 __GLX_VENDOR_LIBRARY_NAME=nvidia flatpak run --env=__NV_PRIME_RENDER_OFFLOAD=1 --env=__GLX_VENDOR_LIBRARY_NAME=nvidia com.google.Chrome \
  --user-data-dir="$HOME/.var/app/com.google.Chrome/data/body-editor" --no-first-run --no-default-browser-check \
  --ozone-platform=x11 --enable-features=Vulkan --class=body-editor --app="$URL" >/dev/null 2>&1 &
sleep 3
kill -0 $! 2>/dev/null || xdg-open "$URL"
