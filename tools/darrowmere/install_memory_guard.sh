#!/bin/bash
# Minnesskydd för Darrowmere (18 GB RAM tills uppgraderingen): ComfyUI får ett tak, så att den aldrig kan frysa hela
# maskinen (SSH, runnern, panelen). Krea-2 (14 GB modell + 5 GB textkodare) tog två gånger 2026-11-09 allt minne, och
# maskinen låg sedan i swap i en halvtimme innan den dog. Körs en gång, med sudo, på Darrowmere:
#   sudo bash ~/install_memory_guard.sh            (ångra: sudo bash ~/install_memory_guard.sh remove)
# 1. Drop-in för comfyui och comfyui-m4000: MemoryHigh (bromsar), MemoryMax (taket i RAM), MemorySwapMax, Restart=always.
#    Över taket swappar ComfyUI inom sin egen grupp eller dödas av kärnan; resten av maskinen har RAM kvar.
# 2. earlyoom: avslutar den största processen (helst ComfyUI) när ledigt minne och swap båda är nästan slut, i stället
#    för att systemet fryser. Ändra eller ta bort taken när 48 GB sitter i.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "kör med sudo"; exit 1; }
UNITS="comfyui comfyui-m4000"
if [ "${1:-}" = remove ]; then
    for u in $UNITS; do rm -f /etc/systemd/system/$u.service.d/memory-guard.conf; done
    systemctl daemon-reload; systemctl disable --now earlyoom 2>/dev/null || true
    echo "memory guard removed (restart ComfyUI to drop the limits: systemctl restart $UNITS)"; exit 0
fi
# T1000-tjänsten kör Krea-2 (ca 19 GB med textkodaren): 14 GB i RAM, resten swap inom gruppen (långsammare, men inget frys).
# M4000 kör Klein 4B och liknande. Med serial_lanes i runnern släpper det andra kortet sina modeller före ett tungt jobb.
for u in $UNITS; do
    if [ $u = comfyui ]; then HIGH=13G; MAX=14G; else HIGH=9G; MAX=10G; fi
    mkdir -p /etc/systemd/system/$u.service.d
    cat > /etc/systemd/system/$u.service.d/memory-guard.conf <<E
[Service]
MemoryAccounting=yes
MemoryHigh=$HIGH
MemoryMax=$MAX
MemorySwapMax=10G
Restart=always
RestartSec=10
OOMScoreAdjust=500
E
done
systemctl daemon-reload
if ! command -v earlyoom >/dev/null; then apt-get install -y earlyoom; fi
# Föredra ComfyUI (python) och Blender, aldrig sshd, systemd eller runnern
cat > /etc/default/earlyoom <<'E'
EARLYOOM_ARGS="-m 4 -s 10 -r 3600 --prefer '(^|/)(python3?|blender)$' --avoid '(^|/)(sshd|systemd|systemd-journald|NetworkManager|wpa_supplicant)$'"
E
systemctl enable --now earlyoom
systemctl restart earlyoom
echo "restarting ComfyUI with the limits (running jobs are lost; the runner re-queues on its next step)"
systemctl restart $UNITS
for u in $UNITS; do systemctl show $u -p MemoryHigh -p MemoryMax -p MemorySwapMax | tr '\n' ' '; echo; done
systemctl is-active earlyoom
