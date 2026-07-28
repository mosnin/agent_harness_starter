#!/usr/bin/env bash
#
# Bundle smoke test — run the SHIPPED BINARY, not the source.
#
# Every defect the product audit found survived a green unit-test suite,
# because CI never executed dist-hades/hades.js. The CJS bundle crashed on
# `gov airgap` (import.meta.url is empty in CJS) while the tsx path was fine;
# `npm run build:lib` had been broken for 250+ commits; and the verification
# gate certified wrong answers on the first live run. This script exercises
# exactly those paths.
#
# It needs no API key and makes no external network call: the "live" lanes run
# against scripts/stub-llm.mjs on loopback.
#
# Usage: scripts/smoke-bundle.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORK="$(mktemp -d)"
STUB_PID=""
cleanup() {
  [ -n "$STUB_PID" ] && kill "$STUB_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

export HADES_DATA_DIR="$WORK/data"
# The stub is on loopback; never let an ambient proxy intercept it.
export NO_PROXY='*' no_proxy='*'
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy 2>/dev/null || true

pass() { printf '  [ok]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; exit 1; }

echo "== building the shipped artifacts =="
npm run build:hades >/dev/null
pass "build:hades"
npx tsup >/dev/null 2>&1 || fail "npm run build:lib (tsup) — this was broken for 250+ commits; keep it in CI"
pass "build:lib (tsup)"

HADES="node dist-hades/hades.js"

echo "== bundle-only crash paths =="
$HADES gov airgap probe >/dev/null || fail "gov airgap probe crashed in the CJS bundle (import.meta.url regression)"
pass "gov airgap probe"
$HADES migrate selftest >/dev/null || fail "migrate selftest failed from the bundle"
pass "migrate selftest"

echo "== the doctor must fail loudly, not silently pass =="
if $HADES trust doctor >/dev/null 2>&1; then
  fail "trust doctor exited 0 on an uncalibrated build — it must exit non-zero when it cannot certify"
fi
pass "trust doctor exits non-zero when unhealthy"

echo "== chat is a real agent, not a stub =="
CHAT_OUT="$($HADES chat --once 'smoke test hello')"
grep -q '\[mock\]' <<<"$CHAT_OUT" || fail "chat --once did not announce the mock brain"
grep -q 'smoke test hello' <<<"$CHAT_OUT" || fail "chat --once did not answer"
grep -q 'available via the Hades REPL API' <<<"$CHAT_OUT" && fail "chat regressed to the old stub"
pass "chat --once (mock brain)"

echo "== the verification gate, against a live endpoint =="
node scripts/stub-llm.mjs --port 8791 --mode wrong 2>/dev/null &
STUB_PID=$!
sleep 1
export OPENAI_API_KEY=sk-smoke-test-not-a-real-key
export OPENAI_BASE_URL=http://127.0.0.1:8791/v1

CHAT_REAL="$($HADES chat --once 'ping')"
grep -q 'chat engine: real' <<<"$CHAT_REAL" || fail "chat did not use the real provider path when a key was present"
grep -q '\[mock\]' <<<"$CHAT_REAL" && fail "chat silently fell back to mock despite a configured key"
pass "chat --once reaches a real endpoint"

# The headline property: a model returning confidently-formatted WRONG answers
# must produce declines, never silent-wrongs.
$HADES showdown live --tasks 4 --seed 5 --out "$WORK/live-wrong" >/dev/null
SILENT_WRONG="$(node -e 'const r=require(process.argv[1]);console.log(r.swarmReport.silentWrong)' "$WORK/live-wrong/result.json")"
DECLINED="$(node -e 'const r=require(process.argv[1]);console.log(r.swarmReport.declined)' "$WORK/live-wrong/result.json")"
[ "$SILENT_WRONG" = "0" ] || fail "swarm lane certified $SILENT_WRONG wrong answer(s) — the gate is not gating"
[ "$DECLINED" -gt 0 ] || fail "swarm lane declined nothing on an all-wrong model — the gate is not gating"
pass "gate declines wrong answers (silent-wrong=0, declined=$DECLINED)"

kill "$STUB_PID" 2>/dev/null || true

# The control: a gate that declines everything is worthless. Same harness, a
# model that actually solves the tasks.
node scripts/stub-llm.mjs --port 8792 --mode solve 2>/dev/null &
STUB_PID=$!
sleep 1
export OPENAI_BASE_URL=http://127.0.0.1:8792/v1
$HADES showdown live --tasks 4 --seed 5 --out "$WORK/live-right" >/dev/null
VERIFIED="$(node -e 'const r=require(process.argv[1]);console.log(r.swarmReport.verifiedCorrect)' "$WORK/live-right/result.json")"
[ "$VERIFIED" -gt 0 ] || fail "swarm lane verified nothing even when the model was right — the gate is a wall, not a gate"
pass "gate accepts correct answers (verified=$VERIFIED)"

echo "== published artifacts are tamper-evident =="
$HADES showdown live-verify "$WORK/live-right" >/dev/null || fail "live-verify rejected its own freshly written artifacts"
pass "live-verify accepts intact artifacts"
sed -i.bak 's/showdown-0000/showdown-XXXX/' "$WORK/live-right/audit.jsonl"
if $HADES showdown live-verify "$WORK/live-right" >/dev/null 2>&1; then
  fail "live-verify accepted a TAMPERED audit ledger"
fi
pass "live-verify rejects a tampered ledger"

echo
echo "bundle smoke: all checks passed"
