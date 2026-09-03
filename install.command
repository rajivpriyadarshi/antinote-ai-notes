#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_DIR="$HOME/Library/Application Support/Antinote AI Notes"
EXTENSIONS_ROOT="$HOME/Library/Application Support/Antinote/Extensions"
EXTENSION_DIR="$EXTENSIONS_ROOT/ai_notes"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/io.antinote.ai-notes.plist"
NODE_BIN="$(command -v node || true)"

if [[ -z "$NODE_BIN" ]] || (( $($NODE_BIN -p 'Number(process.versions.node.split(".")[0])') < 18 )); then
  echo "Node.js 18 or newer is required. Install it from https://nodejs.org and run this installer again."
  read -k 1 "?Press any key to close."
  exit 1
fi

mkdir -p "$APP_DIR" "$EXTENSION_DIR" "$HOME/Library/LaunchAgents"
cp "$SCRIPT_DIR/companion/server.js" "$SCRIPT_DIR/companion/package.json" "$APP_DIR/"
cp "$SCRIPT_DIR/extension/ai_notes/index.js" "$SCRIPT_DIR/extension/ai_notes/extension.json" "$EXTENSION_DIR/"

cat > "$LAUNCH_AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>io.antinote.ai-notes</string>
<key>ProgramArguments</key><array><string>$NODE_BIN</string><string>$APP_DIR/server.js</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$APP_DIR/companion.log</string>
<key>StandardErrorPath</key><string>$APP_DIR/companion-error.log</string>
</dict></plist>
PLIST

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"

echo "Installed Antinote AI Notes."
echo "In Antinote Settings > Extensions, select: $EXTENSIONS_ROOT, then click Reload Extensions."
open "http://127.0.0.1:48732/"
