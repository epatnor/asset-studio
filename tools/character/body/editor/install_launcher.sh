#!/bin/sh
# Lägger Body Editor i appmenyn och på skrivbordet: en .desktop-post som kör tools/character/body/editor/launch.sh. Körs på värden
# (eller via host-spawn). Kör igen om mappen flyttas.
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"   # asset-studio
ENTRY="$HOME/.local/share/applications/body-editor.desktop"
DESKTOP="$(xdg-user-dir DESKTOP)"
mkdir -p "$HOME/.local/share/applications"
cat > "$ENTRY" <<ENTRY_END
[Desktop Entry]
Type=Application
Name=Body Editor
GenericName=Mesh editor
Comment=Simple mesh editor for the character bodies (on the RTX card)
Exec=sh $ROOT/tools/character/body/editor/launch.sh
Path=$ROOT/build/body
Icon=$ROOT/tools/character/body/editor/icon.png
Terminal=false
Categories=Graphics;3DGraphics;
StartupWMClass=body-editor
StartupNotify=true
ENTRY_END
chmod +x "$ENTRY"
ln -sf "$ENTRY" "$DESKTOP/body-editor.desktop"
update-desktop-database -q "$HOME/.local/share/applications" 2>/dev/null
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1
echo "installed: $DESKTOP/body-editor.desktop"
