#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/script/build-output.sh"
HADES_APP_OUTPUT="$(hades_select_build_output "$ROOT")"
export HADES_APP_OUTPUT
./script/build_and_run.sh --build-only
APP="$HADES_APP_OUTPUT"
ARCH="$(uname -m)"
ditto -c -k --sequesterRsrc --keepParent "$APP" "dist-mac/Hades-mac-$ARCH.zip"
hdiutil create -volname Hades -srcfolder "$APP" -ov -format UDZO "dist-mac/Hades-mac-$ARCH.dmg"
echo "Packaged: dist-mac/Hades-mac-$ARCH.zip and .dmg"
