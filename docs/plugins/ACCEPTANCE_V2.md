# Native Plugins and Company OS — source acceptance

2026-09-10. This is a tested local source candidate. **No production provider deployment, installed Hades build, or live account journey is accepted.** The broader Helm goal remains active; the requested additional goal and twelve measurable gates are retained in [PROGRAM.md](PROGRAM.md).

## What is implemented

Hades has a native **Plugins** dropdown for Stored, Operate, Scalar, Company OS, Cadre, Glove and Govern. Each account view includes sign-in, account identity, granted permissions, read/write switches, sync state, collections, search, pagination and record details. The reading view presents named fields and content; All fields retains the complete structured record. Large records are explicitly shortened with an expansion control. Account content is escaped, never executed as HTML. Focus returns to the selected record after closing details; changing account or OAuth scopes clears an open old record.

The native view starts with read-only connection access. Users can select read and write before connection/reconnection. The selected scopes are bound to pending PKCE state and the callback; an overbroad token response is refused. Existing API callers that omit this newly added access option retain the previous read/write request behavior, still subject to provider consent. Local agent switches can only restrict the actual grant. Enabling agent writes also enables their required read access; every agent write uses the existing chat approval queue.

OAuth credentials are encrypted in the sidecar store using a native Keychain master key. Keychain access and callback methods are reserved to the Rust host, never renderer RPC. Native callbacks use `ai.hades.desktop:/oauth/<plugin>`. A single refresh is shared by concurrent requests. An uncertain rotation is retained and requires reconnect. Disconnect fences old work immediately even while remote revoke is pending; missing remote revocation acknowledgement is reported. Durable write receipts prevent replay after cancellation, restart and reconnect. Old retained receipt payloads are not redisclosed. A known pre-dispatch refusal is rejected; a lost acknowledgement after an actual HTTP write attempt remains unknown.

Connection scopes determine the operations and fields advertised to agents. Newly added edits cannot inherit older rename-only consent. Refresh to a smaller grant atomically discards the prior cache and checkpoint. A record or paginated snapshot from mixed grants cannot commit. Product providers independently enforce current actor, organization, membership/role and record ownership as applicable; Hades is not a replacement authorization layer.

Agent tools are `plugins_list`, `plugins_read`, `plugins_record` and `plugins_write`. Reads include account/source/freshness. Large full records can be read in bounded chunks tied to a content hash; a changed record cannot splice into the previous chunk stream. Writes require a stable key, observed revision, explicit source-defined operation and permitted fields. The host's existing Stop and maintenance barriers cancel/drain plugin work. Account cache and framework preferences are explicitly excluded from the current general backup format, which is disclosed rather than silently assumed recoverable.

## Actual product coverage

| Product | Surfaced collections/content | Supported edits | Current sync transport |
| --- | --- | --- | --- |
| Stored | Memory content, summary, source | Memory content with conditional revision; SQLite engine support | Snapshot polling |
| Operate | Workspace, space, project, list, task, agent, run projections | Task title and description; owner/admin | Durable changes plus SSE invalidation source |
| Scalar (`tryscalar.xyz`) | Contact name and notes | Contact name/notes with revision check | Snapshot polling |
| Company OS SaaS | Document index and full versioned content | Main-branch document revision with title/content/message/templateVersion | Durable changes plus SSE invalidation source |
| Cadre | Owned agents, actual task prompts/status, spaces; instructions with separate opt-in | Agent rename; name/description with separate metadata consent | Durable changes polling |
| Glove | Products, sessions, recording metadata, workspaces, knowledge, transcripts, outcomes | Product content/features and knowledge title/content/category/status with dedicated consent | Observed changes from bounded snapshot reconciliation |
| Govern | Agent configuration metadata, policy metadata/targets, workspace metadata | Agent rename; metadata; separately authorized provider/model fields; policy name/description | Durable changes polling |

The client labels live updates only while a Company OS/Operate authenticated SSE watch is active and caught up. This is source behavior tested with injected transports, **not a live streaming claim**. Polling providers refresh while the app is running; Glove observations do not form an audit log of every intermediate event. Snapshot and response limits fail explicitly instead of silently declaring complete data.

This coverage is not every business feature from all seven platforms. Material gaps include Scalar's broader CRM objects, Stored PostgreSQL conditional writes, Govern audit/operational policy editing, Cadre run-linked results/conversations and task execution, and private recording playback. Credentials, signed access handles, raw internal/tool messages and operational secrets are not treated as ordinary plugin record fields. New projections must reuse each product's real visibility rules and explicit consent. Native account browsing must not imply these omitted capabilities exist.

Provider details: [PROVIDERS.md](PROVIDERS.md), [STORED_SCALAR.md](STORED_SCALAR.md), [GLOVE_PROVIDER_V2.md](GLOVE_PROVIDER_V2.md). The v1 documents retain historical evidence; current cross-repository file hashes are in [source-v2-receipt.json](source-v2-receipt.json).

## Company OS framework

This is the actual `mosnin/companyos` framework, distinct from the Company OS SaaS account. Bundled version **0.6.0**, source revision `5b374ba2066332c44f74eafddab4f8f575715ba3`, contains 688 verified distribution files. Bundle SHA-256: `bab686685a36437967e3445934c4af983085a82962c84d63ae17adcf0244d59d`.

Settings provide per-profile enable and automatic-update controls, version/provenance, update check/application and digest-fenced rollback. The actual framework entry skill is attached to the model when enabled; `/company-os` refuses when disabled. Context is bounded without silently cutting instructions. Missing or corrupt optional framework resources do not crash Hades and cannot remain effectively enabled. Host authority, approvals, cancellation and scheduling are not delegated to downloaded content. Runtime controllers and automatic framework scheduling remain feature-off; this integration supplies versioned instructions.

The updater reads the fixed `@mosnin/companyos` npm registry identity, verifies package/version/gitHead, SHA-512 archive integrity and every distributed file, then atomically activates a same-major stable release. Scripts, links and unsupported tar extensions are refused. Releases are retained for verified rollback. Checks run at most every six hours for enabled profiles with auto-update on. Updating a release affects enabled profiles globally; per-profile enable preferences remain separate.

An actual offline `npm pack --ignore-scripts` archive was parsed into exactly the same bundle; [npm-archive-receipt.json](npm-archive-receipt.json) records its hashes. Registry metadata in those tests is injected. **The package has not been published during this task, newest registry availability has not been verified, and Bun has not been executed.** No package license or public redistribution right is inferred from private-source metadata. Details: [COMPANY_OS.md](COMPANY_OS.md).

## Verified evidence

| Gate | Result and scope |
| --- | --- |
| Hades integrated gate | `npm run test:plugins`: **182/182**, 15 files, including 12 independent scope-review cases, actual Workbench chat/approval/Stop paths with an injected model, UI interactions and framework recovery |
| TypeScript | `tsc --noEmit --incremental false`: exit 0 |
| Source bundles | `npm run desktop:build`: sidecar and frontend both pass |
| Rust without GUI feature | `rustc --edition=2021 --test src-tauri/src/main.rs`: **19/19** pure supervisor/renderer-filter/capacity tests. Does not compile native Keychain, Tauri or webview code |
| Bundle metadata | `plutil -lint src-tauri/Info.plist` and `git diff --check` pass |
| Govern | **28/28** portable HTTP/schema/PGlite tests; whole-project types pass; new consent and current-role replay independently reviewed |
| Cadre | **29/29** portable mounted Hono/PGlite tests; replay repair independently accepted after red reproduction; core/API type gates passed before the SQL-only replay repair |
| Glove | **19/19** independent Convex tests; author suite **19/19** (includes the prior seven independent cases) plus **11/11** Node fixtures. These totals overlap and are not summed. Full typecheck still has the same 32 pre-existing diagnostics as its recorded baseline |
| Company OS / Operate providers | Source fixtures, type/lint checks and reviewed SSE/durable change contracts retained in `evidence/companyos-*` and `evidence/operate-*`; no hosted acceptance |
| Scalar / Stored | **30/30** Scalar in-process Prisma fixtures; **21** isolated Stored provisioning/actual SQLite tests. Neither proves full deployed backend compatibility |

The final Hades test, type, build and pure Rust logs are retained under [evidence/](evidence/). Primary source and log digests are bound in [source-v2-receipt.json](source-v2-receipt.json). The gate runner performs no downloads, installations, account access, service listeners or deployment. Desktop tests require a Node runtime with `node:sqlite`; verified here with Node 22.22.2. Provider portable runners require their explicitly declared retained dependencies; they do not silently skip missing fixtures.

Independent reviews and repairs:

- [CLIENT_SCOPE_REVIEW.md](CLIENT_SCOPE_REVIEW.md): per-operation consent, optional scopes, mixed-page privacy, actual dispatch classification, selected OAuth access.
- [CLIENT_RECOVERY_REVIEW.md](CLIENT_RECOVERY_REVIEW.md): stream/reset/drain boundaries. Later connect-intent red/green logs preserve the reconnect race repair.
- [GOVERN_SECURITY_REVIEW.md](GOVERN_SECURITY_REVIEW.md): SQL grants/trigger privileges, replay-family revocation and metadata/configuration consent.
- [CADRE_REPLAY_ACCEPTANCE.md](CADRE_REPLAY_ACCEPTANCE.md): current owner/archive authority and instruction-scope filtering before replay without repeating effects.
- [GLOVE_SECURITY_REVIEW.md](GLOVE_SECURITY_REVIEW.md) and Glove's `scripts/HADES_REVIEW_V2_INDEPENDENT.md`: current target/parent authority, historical payload withdrawal, pagination/tombstone delivery and scoped full records.

## Release work still required

1. Apply the product candidates to their owning release branches, provision Stored's exact native client, apply actual backend migrations/generate API clients, and deploy exact revisions. Preserve pre-existing unrelated edits in Company OS SaaS and Glove. Stored remains an 11-file retained source patch, not a full checkout or applied remote change.
2. Resolve Glove's existing generated LiveKit API/type failures in their owning lane; run full product checks and hosted database concurrency/revocation tests. Complete the additional collection inventory above before claiming all account data.
3. Provide adequate native build disk headroom and run the full GUI feature build. The actual attempt here stopped with `ENOSPC`; the std-only test gate is narrower. Native app control was denied in this session, so no alternate automation path was used.
4. Install the exact candidate and complete all **seven** real OAuth sign-in → browse → agent read → approved revision-checked write → observed sync → revoke/disconnect journeys. Include profile/tenant switching, OS callback, Keychain, offline/restart, cancellation, screen-reader/keyboard and 200% zoom checks. Current accepted count: **0/7**.
5. Publish and verify the actual framework release when the permitted registry/release path is available; test Bun separately, authenticate registry/latest provenance, and verify packaged resources and updates in the installed app.

The authorized attempt to create Stored's isolated remote source tree was refused by the GitHub connector: **“MCP tool call requires approval, but approval policy is never.”** No remote tree, commit or branch was created, and no alternate write path was attempted. The exact preflight and retained patch are in [stored-remote-delivery-receipt.json](stored-remote-delivery-receipt.json). This is a host/tool restriction, not missing user authorization.
