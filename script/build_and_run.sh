#!/bin/bash
# Native macOS build, bundle, ad-hoc sign and launch. No development web server.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MODE="run"
for argument in "$@"; do
  case "$argument" in --build-only) MODE="build";; --verify) MODE="verify";; --debug|--logs|--telemetry) MODE="logs";; *) echo "Unknown option: $argument" >&2; exit 2;; esac
done
if [[ "$(uname -s)" != Darwin ]]; then echo "This script builds the macOS application." >&2; exit 1; fi
npm run desktop:build
mkdir -p dist/runtime dist-mac
NODE_BIN="$(command -v node)"
if [[ ! -f dist/runtime/node ]] || ! cmp -s "$NODE_BIN" dist/runtime/node; then cp "$NODE_BIN" dist/runtime/node; chmod +x dist/runtime/node; fi
if [[ ! -f src-tauri/icons/icon.icns ]] || [[ src/desktop/assets/hades-icon.png -nt src-tauri/icons/icon.icns ]]; then
  swift scripts/macos-icon.swift src/desktop/assets/hades-icon.png dist-mac/Hades.iconset
  iconutil -c icns dist-mac/Hades.iconset -o src-tauri/icons/icon.icns
fi
# Disable debug information and incremental state to keep local builds small.
cc -O2 -Wall -Wextra scripts/macos-pty.c -o dist/runtime/hades-pty
cargo build --manifest-path src-tauri/Cargo.toml --features gui -j "${HADES_BUILD_JOBS:-4}"
APP="$ROOT/dist-mac/Hades.app"
# Stop only the previously built application. Other Node processes are untouched.
pgrep -f "^${APP}/Contents/MacOS/Hades$" | while read -r pid; do
  pkill -TERM -P "$pid" || true
  sleep 1
  kill "$pid" 2>/dev/null || true
done || true
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp src-tauri/target/debug/hades-desktop "$APP/Contents/MacOS/Hades"
cp dist/desktop/sidecar-entry.js "$APP/Contents/Resources/sidecar-entry.js"
cp dist/runtime/node "$APP/Contents/Resources/node"
cp dist/runtime/hades-pty "$APP/Contents/Resources/hades-pty"
cp src-tauri/icons/icon.icns "$APP/Contents/Resources/Hades.icns"
# Keep Node package lookup inside the signed bundle, away from protected parent folders.
cp src-tauri/runtime-package.json "$APP/Contents/Resources/package.json"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Hades</string><key>CFBundleDisplayName</key><string>Hades</string>
<key>CFBundleIdentifier</key><string>ai.hades.desktop</string><key>CFBundleExecutable</key><string>Hades</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string><key>CFBundleIconFile</key><string>Hades.icns</string>
<key>LSMinimumSystemVersion</key><string>12.0</string><key>NSHighResolutionCapable</key><true/>
<key>NSMicrophoneUsageDescription</key><string>Record voice messages when you choose the microphone.</string>
</dict></plist>
PLIST
codesign --force --sign - "$APP/Contents/Resources/node"
codesign --force --sign - "$APP/Contents/Resources/hades-pty"
codesign --force --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built: $APP"
if [[ "$MODE" == build ]]; then exit 0; fi
/usr/bin/open -n "$APP"
if [[ "$MODE" == verify ]]; then
  sleep 2
  pgrep -f "^${APP}/Contents/MacOS/Hades$" >/dev/null
  echo "Native application process is running."
fi
if [[ "$MODE" == logs ]]; then /usr/bin/log stream --predicate 'process == "Hades"' --level info; fi
