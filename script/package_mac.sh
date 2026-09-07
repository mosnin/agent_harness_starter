#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
./script/build_and_run.sh --build-only
ARCH="$(uname -m)"
ditto -c -k --sequesterRsrc --keepParent dist-mac/Hades.app "dist-mac/Hades-mac-$ARCH.zip"
hdiutil create -volname Hades -srcfolder dist-mac/Hades.app -ov -format UDZO "dist-mac/Hades-mac-$ARCH.dmg"
echo "Packaged: dist-mac/Hades-mac-$ARCH.zip and .dmg"
