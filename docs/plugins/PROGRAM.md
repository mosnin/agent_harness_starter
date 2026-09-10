# Native ecosystem plugins and Company OS

Accepted user scope, 2026-09-10. This program adds to the unfinished Helm enterprise goal; it does not waive its gates. The host refused a second active goal, so this document records the requested additional objective and acceptance tests while implementation proceeds.

## Mandatory outcomes

Connect Stored, Operate, Scalar, Company OS, Cadre, Glove and Govern accounts with OAuth. Display connected account data in a native Plugins dropdown and data browser. Agents must read and write through the account's granted permissions. Sync changes with durable recovery and truthful freshness. Integrate the actual /company-os framework, with a Settings toggle, version visibility and verified updates. Change the owning product repositories where necessary. No invented endpoints, simulated accounts or fixture results count as live acceptance.

## Execution baseline

Hades source: mosnin/agent_harness_starter, claude/hermes-swarm-framework-vbhrot, starting 5f624c03ffd81fcdf1190721f30782939d20761e. Existing unrelated changes in other repositories are preserved.

Root owns connector contracts, OAuth/data service, agent tools and integration. Provider lane owns source/auth/API inventory and product adapters. Framework lane owns Company OS distribution and runtime. UI lane owns the native Plugins view and Settings controls. Four host slots limit active concurrency; these are bounded worker lanes, not proof of a fully instrumented Company OS manager hierarchy. Record verification scope, elapsed time, versions and available token observations; do not invent efficiency or live evidence.

## Acceptance gates — current source candidate

| Gate | Required evidence | Current state |
| --- | --- | --- |
| P01 | Exact seven domain/repository/revision/auth/data mappings | Source mapped and pinned; deployed issuer identity remains open |
| P02 | PKCE, unpredictable state, exact redirect, single-use callback, expiry and issuer tests | In-process tests pass, including selected read-only consent and excess-scope refusal |
| P03 | Credentials outside renderer/logs/agent/plain settings; rotation/revocation | Encrypted storage and host boundaries reviewed/tested; native Keychain and live revocation open |
| P04 | Profile/account/tenant isolation and reconnect races | Tests pass, including disconnect during revoke, narrowed scopes and current record ownership |
| P05 | Pagination, changes, tombstones, cursor recovery and reconnect | Bounded fixture gates pass; Company OS/Operate have SSE source; other five use polling; live seven-provider journeys open |
| P06 | Scoped writes, conflicts, uncertain effects and idempotency | Source tests pass; new metadata/configuration consent, receipt privacy and actual dispatch classification independently reviewed |
| P07 | All seven authenticated provider read/write/change/revoke journeys | **Open: 0/7 live account journeys accepted** |
| P08 | Native dropdown/data/detail/filter/error/empty/loading/keyboard/zoom | Native view source and happy-dom interactions pass; native visual, keyboard/zoom and OAuth handoff open |
| P09 | Actual framework provenance, offline version, disabled state and invocation | Actual 688-file Company OS 0.6.0 bundle verified; host chat invocation and Settings source tested |
| P10 | Update integrity, compatibility, rollback and npm/Bun support | Real npm archive plus injected metadata and recovery tests pass; registry publication/latest and actual Bun execution open |
| P11 | Types, source builds and regression suite | TypeScript, sidecar/frontend build and named Plugins suite pass; full GUI build stopped by disk exhaustion |
| P12 | Independent security, native acceptance and deployed revisions | Bounded independent source reviews accepted after repairs; native/install/deployment acceptance remains open |

Run the retained Hades gate with `npm run test:plugins`. It launches only in-process fixtures and requires the repository dependencies and a Node runtime with `node:sqlite`. It does not install software, launch native apps, connect accounts or deploy providers. See [ACCEPTANCE_V2.md](ACCEPTANCE_V2.md) for final counts, contracts, current source hashes and remaining coverage.

This program is **not complete**. Provider source changes remain local; Stored is a retained patch rather than a full checkout. The existing broader Helm goal remains active. Neither repository breadth nor passing fixtures substitutes for P07/P08/P12.

Network, app-control, missing-runtime and authenticated-account restrictions remain open gates. Prior loopback/native permission denials must not be bypassed. Local source work and in-process tests may proceed without claiming installation or production readiness.
