#!/bin/sh
# Startar Asset Studio: studioservern (tools/studio/server.mjs) och studion i webbläsaren.
# Värden har ingen Node, så servern körs i distrobox-containern claude-desktop (där node och uv finns);
# containern delar nätverk med värden, så studion nås på localhost. Körs servern redan öppnas bara studion.
#   STUDIO_PORT=8770 (standard)   STUDIO_NO_OPEN=1 startar bara servern
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PORT=${STUDIO_PORT:-8770}
URL="http://localhost:$PORT/studio/"
LOG="$ROOT/build/studio/server.log"
up() { curl -s -o /dev/null "http://127.0.0.1:$PORT/api/generators"; }

mkdir -p "$ROOT/build/studio"
if ! up; then
	if command -v node >/dev/null 2>&1; then
		nohup node "$ROOT/tools/studio/server.mjs" "$PORT" > "$LOG" 2>&1 &
	else
		nohup distrobox enter claude-desktop -- node "$ROOT/tools/studio/server.mjs" "$PORT" > "$LOG" 2>&1 &
	fi
	i=0
	until up; do
		i=$((i + 1))
		if [ "$i" -gt 60 ]; then echo "Studioservern svarar inte; se $LOG" >&2; exit 1; fi
		sleep 0.25
	done
fi
[ -n "$STUDIO_NO_OPEN" ] && exit 0
exec xdg-open "$URL"
