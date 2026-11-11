#!/bin/bash
# Prepares a worker (Darrowmere, later the T5810) for sleep and Wake-on-LAN. Run once on the machine with sudo, after
# deploy_runner.sh, with the network cable in:
#   ssh -t epatnor@<host> 'sudo bash /data/runner/install_power.sh'
# What it does:
#   - Wake-on-LAN (magic packet) on every wired port, now and at every boot (NetworkManager default + a oneshot unit)
#   - lets the runner (user epatnor) suspend the machine without a password
#   - restarts the ComfyUI services after waking, so CUDA starts clean
# It does not turn auto-suspend on: that is "power": {"auto_suspend": true} in runner.json or runner.local.json,
# after a manual test (sudo systemctl suspend, then python3 -I tools/darrowmere/machine.py wake on the laptop).
# BIOS: Wake on LAN / "PME Event Wake Up" Enabled and ErP Disabled (Darrowmere, Gigabyte X58); on the Dell T5810
# "Wake on LAN/WLAN: LAN Only" and "Deep Sleep Control: Disabled" under Power Management.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }

# 1. Wake-on-LAN: NetworkManager's default for every wired connection, and ethtool at boot for ports it does not manage
mkdir -p /etc/NetworkManager/conf.d
cat > /etc/NetworkManager/conf.d/60-wake-on-lan.conf <<'E'
[connection]
ethernet.wake-on-lan=magic
E
cat > /usr/local/sbin/darrowmere-wol <<'E'
#!/bin/bash
# Turns on Wake-on-LAN (magic packet) on every wired port that supports it
for d in /sys/class/net/*; do
  i=$(basename "$d")
  [ -e "$d/device" ] && [ ! -d "$d/wireless" ] || continue
  /usr/sbin/ethtool "$i" 2>/dev/null | grep -q 'Supports Wake-on:.*g' && /usr/sbin/ethtool -s "$i" wol g && echo "wol g: $i"
done
exit 0
E
chmod 755 /usr/local/sbin/darrowmere-wol
cat > /etc/systemd/system/darrowmere-wol.service <<'E'
[Unit]
Description=Wake-on-LAN on the wired ports (Darrowmere power saving)
After=network.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/darrowmere-wol

[Install]
WantedBy=multi-user.target sleep.target
E

# 2. The runner may suspend (and the panel may wake services) without a password
echo 'epatnor ALL=(root) NOPASSWD: /usr/bin/systemctl suspend' > /etc/sudoers.d/darrowmere-power.tmp
chmod 440 /etc/sudoers.d/darrowmere-power.tmp
visudo -cf /etc/sudoers.d/darrowmere-power.tmp
mv /etc/sudoers.d/darrowmere-power.tmp /etc/sudoers.d/darrowmere-power

# 3. After waking: restart ComfyUI (old NVIDIA drivers do not always bring CUDA back cleanly) and set WoL again
cat > /usr/lib/systemd/system-sleep/darrowmere <<'E'
#!/bin/bash
# $1 = pre|post, $2 = suspend|hibernate|...
if [ "$1" = post ]; then
  /usr/local/sbin/darrowmere-wol >/dev/null
  for s in comfyui.service comfyui-m4000.service; do
    systemctl is-enabled --quiet "$s" 2>/dev/null && systemctl restart --no-block "$s"
  done
  logger -t darrowmere-power "woke up, ComfyUI restarted"
fi
exit 0
E
chmod 755 /usr/lib/systemd/system-sleep/darrowmere

systemctl daemon-reload
systemctl enable --now darrowmere-wol.service
nmcli -t -f NAME,TYPE connection show 2>/dev/null | awk -F: '$2 ~ /ethernet/ {print $1}' | while read -r c; do
  nmcli connection modify "$c" 802-3-ethernet.wake-on-lan magic && echo "nm wol magic: $c"
done
cat /sys/power/mem_sleep
for d in /sys/class/net/*; do
  i=$(basename "$d"); [ -e "$d/device" ] && [ ! -d "$d/wireless" ] || continue
  echo "$i $(cat "$d/address") $(/usr/sbin/ethtool "$i" | grep -E '^\s*Wake-on:' | xargs) link $(cat "$d/carrier" 2>/dev/null || echo 0)"
done
echo "done: test with 'sudo systemctl suspend' and wake from the laptop: python3 -I tools/darrowmere/machine.py wake"
