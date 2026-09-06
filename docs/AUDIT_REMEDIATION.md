# Audit remediation — 2026-09-06

Repository: `mosnin/agent_harness_starter`. Development branch:
`claude/hermes-swarm-framework-vbhrot`. Baseline:
`83e63c1f667b7c061def6a67ebed3ddeebcf4210` on `main`.

## Delivered behavior

- `hades chat` now runs a model-backed tool loop. It can read/write workspace
  files, remember conversation context, resume an existing session from disk,
  enforce step limits and cancel model requests. OpenAI, native Anthropic and
  explicitly configured local OpenAI-compatible endpoints share one resolver.
  Local endpoints do not inherit cloud API keys.
- Default CLI swarm runs and the desktop sidecar use the same executor.
  Missing configuration no longer silently selects a demo worker. Demo mode is
  explicit and reaches child processes. Worker provider settings propagate to
  process/container providers. Default real plans use one task to avoid shared
  file races. Restarts restore prior goal records without replaying interrupted
  actions. File-state writes are serialized and new state files use mode 0600.
- The gate rejects absent/fabricated evidence, citations to tool arguments or
  failed outputs, and final answers not represented by a claim. A configured
  judge's failure or outage vetoes admission. Traceability is not entailment.
- Gateway completion counts alone cannot produce a correctness certificate.
  Issuance requires an independent outcome checker and explicit calibration.
  The STYX runner no longer silently installs synthetic calibration or a shared
  fixed signing key. Cluster/MCP receipts carry signed integrity scope and cannot
  become correctness badges or pass the skill-synthesis correctness admission.
- Model usage and estimated cost survive the worker/manager path and failed
  verifier calls. Unknown or zero spend makes per-dollar throughput unavailable.
  The real single-agent evaluation adapter does not claim self-verification;
  Showdown's surrogate is clearly distinguished from an actual Hermes run.
- Fixed macOS path aliases, browser discovery across platform cache layouts,
  installer chmod compatibility, test typing, a TCP fixture connection race,
  and a truncated skill-import message that hid the overwrite instruction.
  Federation shutdown now closes late reconnect sockets, ignores events from
  replaced wires and refuses to register requests after shutdown. A regression
  that failed against the prior implementation verifies late-socket cleanup.
  CI now checks CLI/swarm/desktop JavaScript on Linux and macOS using locked
  installs, rather than treating the legacy Next.js app as the product.

## Local evidence

At baseline, the full suite reported 59 failed, 11,742 passed and 45 skipped
checks; the type checker produced 83 diagnostics. After remediation:

| Check | Result |
|---|---|
| TypeScript | Pass, no diagnostics |
| Full Vitest run | 507 files passed; 11,862 tests passed, 0 failed, 1 skipped |
| CLI build | Pass |
| Swarm CLI + worker build | Pass |
| Desktop sidecar + webview JavaScript build | Pass |
| Packaged CLI smoke | Real file edit, session resume in a second process, clear missing-credential failure |
| Packaged swarm smoke | Inline and actual child-process execution, two goals restored across processes, token accounting retained |
| Original audit probes | Both fabricated/uncovered-answer cases rejected; wrong gateway answer receives no certificate |
| Federation shutdown follow-up | 233 distributed-runtime tests pass; type checking passes |
| Original macOS file-root probe | Both `/tmp` alias and canonical root read the fixture successfully |

The full local run above was performed for `d70bdc4`. Its clean Linux GitHub
run also passed tests, builds and both smoke tests. A macOS hosted reconnect
timeout led to the additional shutdown regression and fix. Full clean-platform
results for subsequent commits are recorded in [Agent CI](https://github.com/mosnin/agent_harness_starter/actions/workflows/ci.yml).

The new workflow tests use deterministic model transports. The packaged tests
use real localhost HTTP, actual CLI/worker processes and temporary files. They
validate wiring and persistence; they do not establish live model quality.
No live model credentials were configured or used. The local dependency install
was reused from the preserved audit checkout; clean installation is a CI gate.
Builds retain dependency warnings from that symlinked checkout and experimental
Node SQLite warnings. None failed a check.

See the [validation receipt](validation/2026-09-06/receipt.json),
[probe outcomes](validation/2026-09-06/audit-probes.json), and
[packaged smoke receipts](validation/2026-09-06/smoke-results.json).
The commands and smoke scripts are reproducible from the README.

## Remaining acceptance boundaries

- Live provider behavior, cost estimates against actual bills and long-running
  real user tasks have not been validated in this change.
- A trace or a valid signature does not prove semantic correctness. Calibration
  frequencies are not per-answer probabilities, and the legacy gate heuristic
  does not establish a distribution-free conditional-error guarantee.
- Shell remains an opt-in host capability, not an OS sandbox. Workspace path
  checks are not a full malicious-host isolation boundary. Docker worker
  deployment, networking and workspace mounts require separate exercised tests.
- Native macOS/Linux/Windows installers and an interactive desktop session were
  not built/launched here. The JavaScript bundle checks are narrower evidence.
- The full suite has one skipped check. Optional provider/backend integrations
  and the pre-existing learning/market/federation scaffolding are not all
  production-accepted by these changes.
- No same-task, same-model, same-budget experiment against the actual Hermes,
  Codex or Claude Code harness has been run. No competitive superiority claim
  follows from unit tests or the local surrogate scoreboard.

The GitHub default branch is still the legacy starter branch. This change stays
on the repository-mandated development branch; it does not merge, publish a
release, or change repository defaults.
