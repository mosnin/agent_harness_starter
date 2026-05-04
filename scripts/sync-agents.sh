#!/usr/bin/env bash
# sync-agents.sh — pull the latest agent infrastructure into your project
#
# Usage (from your project root, with this repo cloned alongside):
#   bash ../agent_harness_starter/scripts/sync-agents.sh
#
# Or with npx degit (no clone needed):
#   npx degit mosnin/agent_harness_starter/src/agents src/agents
#   npx degit mosnin/agent_harness_starter/routes routes
#
# What it does:
#   1. Copies src/agents into your project (preserves your local changes via git diff)
#   2. Prints a summary of what changed so you can review before committing
#
# Requirements: git, bash. Run from your project root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS_DIR="$(dirname "$SCRIPT_DIR")"
TARGET_DIR="${1:-src/agents}"

echo "==> Syncing agent infrastructure from $HARNESS_DIR/src/agents → $TARGET_DIR"

if [ ! -d "$TARGET_DIR" ]; then
  echo "    Creating $TARGET_DIR (first sync)"
  cp -r "$HARNESS_DIR/src/agents" "$TARGET_DIR"
  echo "    Done. Run: git add $TARGET_DIR && git commit -m 'chore: add agent infrastructure'"
  exit 0
fi

# Show a diff of what would change before copying
TMPDIR_COPY=$(mktemp -d)
cp -r "$HARNESS_DIR/src/agents/." "$TMPDIR_COPY/"

echo ""
echo "==> Changes since your last sync:"
diff -rq --exclude="*.js" --exclude="*.d.ts" "$TARGET_DIR" "$TMPDIR_COPY" || true
echo ""

read -p "Apply these changes? [y/N] " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  cp -r "$HARNESS_DIR/src/agents/." "$TARGET_DIR/"
  echo "==> Synced. Review changes with: git diff $TARGET_DIR"
  echo "    Then: git add $TARGET_DIR && git commit -m 'chore: sync agent infrastructure'"
else
  echo "==> Aborted. No files changed."
fi

rm -rf "$TMPDIR_COPY"
