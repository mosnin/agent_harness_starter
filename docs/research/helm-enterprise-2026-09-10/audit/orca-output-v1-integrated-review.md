# Orca output v1 integrated receipt review

2026-09-10. Read-only final checkpoint audit. This report is intentionally outside the frozen receipt. No tests, builds, native app control, listeners, network, provider execution or deployment were run during this audit.

## Frozen identity and integrity

- Repository: `mosnin/agent_harness_starter`, local branch `claude/hermes-swarm-framework-vbhrot`.
- Verified current precommit HEAD: `c44644192872ff9e0887e38c9a68df1e910dc376`.
- Receipt: `orca-output-v1-receipt.json`.
- Receipt SHA-256: **`3d1aad8fe2454a309a7d077cd37d72c1fce0b719777ab46e0a3182f6182f68d3`**.
- **98 bound references / 98 unique paths checked: 93 source/evidence files, four built artifacts, one prior v3 receipt. Zero missing files, byte-size mismatches or hash mismatches.**

The UI receipt remains byte-identical at `c680bb376f043e753373e8d90af23a4bc7ad03a898521bbeb281f6b438d827a6`. Its eight bound files and both nested verification logs also match their byte lengths and hashes. This verifies the retained DOM/source evidence, not native visual quality.

All current tracked modifications and untracked additions belong to the frozen file allowlist, except the receipt itself. There were no staged files during inspection. Changes cover Orca provenance/import, existing Helm verification/apply and source-check guards, Work ownership/recovery/acceptance, scoped routing, associated UI/tests and checkpoint documentation. The `.gitattributes` addition preserves evidence logs; the runner expansion names explicit offline fixture suites. No unrelated source delta was found in this bounded final inspection.

## Evidence arithmetic

| Retained final command | Verified log result |
|---|---|
| `npm run test:work:offline` | 296 passed, 29 files |
| `npm run test:plugins` | 254 passed, 18 files |
| Full TypeScript check | Receipt records exit 0; captured log is empty |
| `npm run desktop:build` | Receipt records exit 0; retained log shows sidecar and frontend bundle completion |

The recorded runner lists have exactly one intersecting file: `desktop-request-routing.test.ts`, with 11 shared cases. Therefore **296 + 254 - 11 = 539 distinct cases**, across **29 + 18 - 1 = 46 files**. The focused 102-case UI pass and earlier independent/author reruns overlap these suites and are not additive. Historical failed logs are retained separately from the selected passing verification logs. Empty TypeScript output alone is not an exit-status receipt; its successful status is supplied by the frozen command record, which this audit did not rerun.

All four captured build outputs match their recorded hashes. These are desktop source bundles, not proof of the exact packaged Orca engine, rebuilt Helm fork, installed native shell or authenticated provider execution.

## Claims and acceptance scope

The checkpoint report, enterprise PROGRAM/STATUS and capability follow-up consistently retain `goalStatus: active`, `productAccepted: false`, and **0/7 accepted live OAuth account journeys**. They distinguish injected Orca/model contracts plus actual disposable Git/SQLite/command tests from provider operation. They also retain unknown usage, uncertain-effect reservations and the distinction between worker exit, isolated verification, source application and explicit task acceptance.

Still open: exact packaged Orca/PTY/watcher/provider execution; legacy provenance recovery and explicit replacement-worker retry semantics; cross-engine provider budget enforcement; a real 60-minute team/restart trial; installed native visual/keyboard/pointer acceptance; real capture-to-code operation; hosted provider migrations/deployments; seven live account journeys; and the matched product comparison. No remote delivery or installed-product acceptance was inferred from this local checkpoint.

**Disposition: accepted as a reproducible local source/evidence checkpoint.** No concrete receipt-integrity, count, delivery-scope or documentation-consistency blocker was found. This reviewer authored parts of the import implementation and independently reviewed other boundaries; this final audit independently verifies frozen bytes and evidence claims, and does not claim a fresh independent re-audit of every implementation or completion of the broader product goal.
