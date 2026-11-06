#!/bin/bash
# Lägger in Meshy-nyckeln på båda ställena utan att den syns eller hamnar i chatten:
#  1. Claude Codes MCP-server "meshy" på den här datorn (~/.claude.json)
#  2. Beställningsrunnern på Darrowmere (/data/runner/.env, läge 600)
# Kör i terminalen och klistra in nyckeln när den frågar:
#   bash tools/darrowmere/set_meshy_key.sh
set -euo pipefail
for try in 1 2 3; do
  read -rsp "Paste your Meshy API key with Ctrl+Shift+V (it stays hidden), then press Enter: " KEY; echo
  KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
  [[ "$KEY" =~ ^msy_[A-Za-z0-9_-]{16,}$ ]] && break
  if [ -z "$KEY" ]; then echo "Nothing arrived. In this terminal, paste with Ctrl+Shift+V or right-click → Paste."
  else echo "Got ${#KEY} characters starting with '${KEY:0:4}', but a Meshy key starts with msy_."; fi
  KEY=""
done
[ -n "$KEY" ] || { echo "Nothing was changed."; exit 1; }

claude mcp remove meshy --scope user >/dev/null 2>&1 || true
claude mcp add --scope user meshy --env "MESHY_API_KEY=$KEY" -- npx -y "@meshy-ai/meshy-mcp-server@0.6.9" >/dev/null
echo "Laptop: MCP server meshy added"

{ printf '%s\n' "$KEY"; cat <<'PY'
import os, json, time
D = "/data/runner"; E = D + "/.env"; M = D + "/keys_meta.json"
lines = [l for l in (open(E).read().splitlines() if os.path.exists(E) else []) if l and not l.startswith("MESHY_API_KEY=")]
lines.append("MESHY_API_KEY=" + k)
fd = os.open(E + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, ("\n".join(lines) + "\n").encode()); os.close(fd); os.replace(E + ".tmp", E); os.chmod(E, 0o600)
m = json.load(open(M)) if os.path.exists(M) else {}
m["MESHY_API_KEY"] = {"hint": k[-4:], "saved": time.time(), "by": "set_meshy_key.sh"}
json.dump(m, open(M, "w")); os.chmod(M, 0o600)
print("Darrowmere: key saved for the runner")
PY
} | ssh -o BatchMode=yes epatnor@192.168.0.33 'python3 -c "import sys; k = sys.stdin.readline().strip(); exec(sys.stdin.read())"'
unset KEY
claude mcp list 2>/dev/null | grep -i meshy || true
echo "Done. Restart the Claude session so the Meshy tools load."
