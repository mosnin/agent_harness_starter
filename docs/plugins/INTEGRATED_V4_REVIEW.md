# Integrated v4 checkpoint review

2026-09-10. Bounded final verification of receipt bytes, retained command evidence and local delivery state. This report is intentionally outside the frozen allowlist. No tests, builds, network, listeners, native app control, installation, remote writes or deployment were performed during this audit. No implementation or frozen receipt was edited.

## Receipt integrity

Verified receipt SHA-256:

**`727ab4f92b118dc0e5b906c9246ed103bfd2bdd9b05c6a1fdb321ffbf2e09cac`**

Verified Hades precommit HEAD `0ce9849738f4851a4c80d66a99a8cd23431be54a` on `claude/hermes-swarm-framework-vbhrot`.

**197 unique bound paths matched both SHA-256 and byte length, with zero missing files or mismatches:** 81 Hades source/evidence files, four build artifacts, two historical parent receipts, 109 provider files and the additional Company OS independent fixture. Historical parent receipts were verified as immutable documents; their old source/build entries were not recursively treated as assertions about current files.

All current Hades tracked changes and untracked additions were in the frozen allowlist except the receipt itself. Nothing was staged at inspection. Source changes match the bounded streaming-fallback, framework-resource, tests/runner and documentation scope.

## Local provider delivery

Current HEADs and branches matched the receipt. For locally delivered providers, candidate file hashes were also checked against committed blobs, not only working files.

| Provider | Local HEAD | Verified state |
|---|---|---|
| Govern (`mosnin/agentid`) | `4405bb13a387b37dd0ef1748cb89c6ca777e7c43` | `codex/hades-plugins-oauth`, clean; 15 allowlisted commit files |
| Company OS SaaS | `3992fe67c0b7fafeffeb14642c68fd374f0fd7cb` | `codex/hades-plugins-oauth`; 23 allowlisted commit files; 41 unrelated dirty files remain |
| Operate | `db0344050e4058f8956446748a4e075debd38b7d` | `codex/hades-plugins-oauth`, clean; 21 allowlisted commit files |
| Cadre | `81188b66656053de979010218044445f7856bc07` | `codex/hades-plugins-messages`, clean |
| Scalar | `542aea19d5bfbca44b998a6342fc69a0359e6b7b` | `codex/hades-plugins-crm-v2`, clean |
| Glove | `89e49e4fb4e13ec77699ac043e50087ad567df05` | Existing `codex/persistent-demo-computers`; 103 dirty files, nothing staged; not delivered by this pass |

Stored remains the two receipt-bound retained patch artifacts, not a delivered provider checkout. No provider state is promoted to pushed, migrated or deployed.

Company OS preservation qualification: this audit independently verified the current 41 excluded dirty paths, clean staging area, and exact 23-file commit scope. The root reports an executed in-memory before/after SHA-256 comparison across those 41 files during its selective commit. That historical map was not retained, so byte-for-byte preservation is root delivery-check evidence, not an independently reconstructed before-state proof. No retrospective hashes were fabricated.

## Verification and count consistency

The selected final retained logs match the command record:

- Plugins: **303 passed, 21 files**.
- Work/Helm: **296 passed, 29 files**.
- Full TypeScript: recorded exit 0; final log empty.
- Desktop source build: recorded exit 0; log shows sidecar and frontend bundle completion; all four outputs match their recorded hashes.

The runner lists intersect only at `desktop-request-routing.test.ts`, containing 11 cases. Thus **303 + 296 - 11 = 588 distinct cases across 21 + 29 - 1 = 49 files**. The 49 new Plugins cases comprise 13 author streaming, three independent streaming, 32 resource and one complete-skill host case. Focused/historical/independent reruns are subsets and are not additional distinct cases.

The retained TypeScript red identifies two optional-validator calls in the new resource tests. The final test-only correction and subsequent passing Plugins/type evidence are recorded separately; reviewed production resource hashes remained unchanged. Empty TypeScript output is consistent with success but does not independently prove an exit status; that status comes from the frozen command receipt, not a rerun in this audit.

## Disposition and limitations

ACCEPTANCE_V4, Plugins PROGRAM and enterprise PROGRAM/STATUS consistently retain an active broader goal, `productAccepted: false` and **0/7 accepted live account journeys**. Streaming polling is bounded while Hades runs, not a guarantee of remote latency. Framework resources remain verified text data, not execution authority or a completed framework controller. Source bundles do not establish native application or actual provider operation.

Still open: installed native OAuth/Keychain/UI journeys, live provider sync and conditional writes, provider migrations/deployment, framework publication/update distribution and Bun execution, exact packaged Orca/PTY/provider execution, broader budget/recovery controls, a real long-running team trial and matched product comparison.

**Accepted as a reproducible local source/evidence checkpoint.** No concrete receipt-integrity, count, allowlist or delivery-claim blocker was found. This review independently verifies frozen bytes and evidence consistency; it is not a fresh independent security audit of every file or acceptance of the entire product.
