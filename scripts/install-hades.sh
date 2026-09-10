#!/usr/bin/env bash
# Installer for the Hades CLI. Verifies Node, installs dependencies, type-checks
# the library, and drops a `hades` launcher onto your PATH (~/.local/bin).
#
# Usage: ./scripts/install-hades.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="${HADES_BIN_DIR:-$HOME/.local/bin}"
LAUNCHER="$BIN_DIR/hades"

echo "==> Checking prerequisites"
if ! command -v node >/dev/null 2>&1; then
  echo "error: Node.js is required (v18+). Install it and re-run." >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "error: Node.js 18+ required (found $(node -v))." >&2
  exit 1
fi

echo "==> Installing dependencies"
cd "$REPO_ROOT"
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

echo "==> Type-checking the library"
npx tsc --noEmit -p tsconfig.lib.json

echo "==> Installing launcher to $LAUNCHER"
mkdir -p "$BIN_DIR"
cat > "$LAUNCHER" <<EOF
#!/usr/bin/env bash
exec node --import tsx "$REPO_ROOT/src/hades/bin/hades.ts" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "==> Done."
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Run: hades help" ;;
  *) echo "Add $BIN_DIR to your PATH, then run: hades help" ;;
esac
