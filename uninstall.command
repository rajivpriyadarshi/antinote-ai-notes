#!/bin/zsh
set -euo pipefail

APP_DIR="$HOME/Library/Application Support/Antinote AI Notes"
EXTENSION_DIR="$HOME/Library/Application Support/Antinote/Extensions/ai_notes"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/io.antinote.ai-notes.plist"

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
/bin/rm -f "$LAUNCH_AGENT"
/bin/rm -rf "$APP_DIR"
/bin/rm -rf "$EXTENSION_DIR"
/usr/bin/security delete-generic-password -s "Antinote AI Notes" >/dev/null 2>&1 || true
echo "Antinote AI Notes was removed. Reload extensions in Antinote to remove its commands."
