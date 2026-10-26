#!/bin/sh
# Lägger Asset Studio i appmenyn: ikonen i ikontemat (hicolor) och en .desktop-post som kör tools/studio/launch.sh.
# Körs på värden (eller via host-spawn). Kör igen om mappen flyttas.
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ICONS="$HOME/.local/share/icons/hicolor"
for s in 512 256 192 128 64 48 32; do
  src="$ROOT/studio/img/icon/icon-$s.png"
  [ -f "$src" ] || continue
  mkdir -p "$ICONS/${s}x${s}/apps"
  cp "$src" "$ICONS/${s}x${s}/apps/asset-studio.png"
done
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/asset-studio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Asset Studio
GenericName=Asset forge
Comment=Azshara Asset Studio: trees, props, plants, textures, wind and grass from recipes (on the RTX card)
Exec=sh $ROOT/tools/studio/launch.sh
Path=$ROOT
Icon=asset-studio
Terminal=false
Categories=Graphics;3DGraphics;
StartupWMClass=asset-studio
StartupNotify=true
EOF
gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null
update-desktop-database -q "$HOME/.local/share/applications" 2>/dev/null
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1
echo "installed: $HOME/.local/share/applications/asset-studio.desktop"
