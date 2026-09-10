# Integrated v3 freeze review

2026-09-10. Read-only verification of the frozen local source receipt and retained evidence. This document is intentionally outside that receipt. No source, manifest, provider checkout or evidence file was edited; no test/build, native app, listener, network or deployment was run during this pass.

## Receipt integrity

Verified `source-v3-receipt.json` SHA-256 exactly:

`d7d14b70ca21c652c126a86a8c7865bca696d183891f7b0d80607b6eeec0fef2`

Every bound file was read and checked for both byte length and SHA-256. Results:

- 97 Hades file references: matched.
- 109 provider file references: matched.
- 32 newly captured evidence references: matched.
- Prior v2 receipt reference: matched.
- **239 checked references, 207 unique filesystem paths, zero missing files or mismatches.** All 32 evidence entries also appear in the 97 Hades entries. They must not be counted as another 32 unique files.

## Local provider delivery

Direct Git inspection confirmed both exact commits, branches and empty porcelain status:

| Provider | Branch | Local HEAD |
|---|---|---|
| Scalar | `codex/hades-plugins-crm-v2` | `542aea19d5bfbca44b998a6342fc69a0359e6b7b` |
| Cadre | `codex/hades-plugins-messages` | `81188b66656053de979010218044445f7856bc07` |

These are local commits with clean worktrees, not evidence of remote delivery, hosted migrations or deployed provider revisions. Other providers retain the delivery classifications in the receipt; this review does not promote them to committed/deployed status.

## Verification and count consistency

The retained Plugins log reports **247 passed in 18 files**. The refrozen `hades-v3-work-brand-tests.log` reports **127 passed in 16 files**. The two captured runner file lists are disjoint, so these represent 374 passing cases across 34 selected files for this candidate. Smaller independent reruns and historical runs are subsets or repetitions and must not be added to that total.

The refrozen `hades-v3-brand-build.log` shows successful sidecar and desktop frontend bundles. The receipt records exit zero for the full TypeScript command; its refrozen `hades-v3-brand-types.log` is empty, consistent with successful `tsc --noEmit --incremental false`. This pass verified the retained evidence rather than rerunning either command. Source bundles are not native application, forked Helm, Orca daemon, PTY or provider acceptance.

Provider evidence remains separately scoped: Scalar's 26 author plus 7 distinct independent fixtures; Cadre's 56-case author aggregation plus 9 distinct message-review cases. Cadre's 56 already includes 29 prior provider cases and 11 shared-visibility cases. Prior/repeated provider logs must not be added again. Their deterministic Prisma-port/PGlite limitations remain explicit.

## Truthfulness and disposition

`ACCEPTANCE_V3.md`, Plugins `PROGRAM.md`, enterprise `PROGRAM.md` and enterprise `STATUS.json` consistently retain an active goal and incomplete product acceptance. The receipt states **0/7 live account journeys**, `goalStatus: active` and `productAccepted: false`. Documentation distinguishes the earlier baseline from this file-bound follow-up candidate.

Actual native OAuth/account journeys, hosted provider deployment/migrations, native visual/keyboard checks, exact packaged Orca and provider execution, worktree acceptance, provider-wide budgets, a real long-running team/restart trial and matched comparisons remain open. No local test or source commit is presented as proof of those gates.

No concrete freeze-integrity or documentation-consistency defect was found. The candidate is accepted as a reproducible **local source/evidence checkpoint**, not product completion. This reviewer previously authored parts of the Work/provider implementation and independently reviewed other parts; this final pass independently verifies receipt bytes, delivery state and evidence consistency, rather than claiming a fresh independent re-audit of every implementation.

## Branding re-freeze

Final verification used `freezeRevision: 2`. The initial receipt was held after the root found a visible OpenCode label in the new Work selector. The corrected selector and saved-task summary display Helm, while the protocol value remains `opencode`. The owner reran Work tests, TypeScript and source bundles and retained both old and new evidence. All bound files were rehashed after this correction; the counts and digest above describe the final freeze. The repeated 127-case Work run is not an additional 127 distinct tests.
