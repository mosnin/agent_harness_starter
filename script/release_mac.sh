#!/bin/bash
# Release-only path. Credentials stay in an existing Keychain profile.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
source "$ROOT/script/build-output.sh"
HADES_APP_OUTPUT="$(hades_select_build_output "$ROOT")"
export HADES_APP_OUTPUT
if [[ "$(uname -s)" != Darwin ]]; then echo "A Mac is required." >&2; exit 1; fi
: "${HADES_SIGN_IDENTITY:?Set an installed Developer ID Application identity.}"
: "${HADES_NOTARY_PROFILE:?Set the name of an existing notarytool Keychain profile.}"
if [[ "$HADES_SIGN_IDENTITY" != "Developer ID Application:"* ]]; then echo "Use a Developer ID Application identity." >&2; exit 1; fi
if [[ -n "$(git status --porcelain)" ]]; then echo "Commit or resolve source changes before making a release candidate." >&2; exit 1; fi
security find-identity -v -p codesigning | grep -F -- "$HADES_SIGN_IDENTITY" >/dev/null || { echo "Signing identity is not available." >&2; exit 1; }
REVISION="$(git rev-parse HEAD)"
RECEIPT="$ROOT/dist-mac/notary-$REVISION.json"
mkdir -p "$ROOT/dist-mac"
if [[ -e "$RECEIPT" ]]; then echo "Notary receipt already exists. Inspect its request before any resubmission: $RECEIPT" >&2; exit 1; fi
RELEASE_LOCK="$ROOT/dist-mac/.release-$REVISION"
mkdir "$RELEASE_LOCK" || { echo "This revision already has a release operation in progress." >&2; exit 1; }
trap 'rmdir "$RELEASE_LOCK" 2>/dev/null || true' EXIT
export HADES_HELM_REQUIRE_PIN=1
npm run helm:build -- --source "${HADES_HELM_OPENCODE_SOURCE:-$ROOT/vendor/opencode}"
./script/build_and_run.sh --build-only
APP="$HADES_APP_OUTPUT"
if [[ "$(git rev-parse HEAD)" != "$REVISION" || -n "$(git status --porcelain)" ]]; then echo "Source changed during build; release refused." >&2; exit 1; fi
ARCH="$(uname -m)"
ARCHIVE="$ROOT/dist-mac/Hades-$ARCH-$REVISION.zip"
codesign --verify --deep --strict "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
# A failure or lost acknowledgement retains the receipt and is never retried here.
( set -o noclobber; xcrun notarytool submit "$ARCHIVE" --keychain-profile "$HADES_NOTARY_PROFILE" --wait --output-format json > "$RECEIPT" )
node --input-type=module -e 'import fs from "node:fs"; const r=JSON.parse(fs.readFileSync(process.argv[1])); if(r.status!=="Accepted") throw new Error("Notarization was not accepted; inspect the retained receipt.");' "$RECEIPT"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$ARCHIVE"
shasum -a 256 "$ARCHIVE" > "$ARCHIVE.sha256"
echo "Notarized archive ready for release acceptance: $ARCHIVE"
