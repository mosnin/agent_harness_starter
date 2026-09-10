# Plugins recovery and complete framework reading

2026-09-10. Follow-up to local Hades `0ce9849738f4851a4c80d66a99a8cd23431be54a`, which committed the reviewed Orca output handoff. This checkpoint closes two concrete source defects in the native Plugins and Company OS implementation. The [program](PROGRAM.md) remains active. No installed application or live account journey is accepted.

## Sync when streaming is unavailable

Company OS and Operate previously took the event-stream path exclusively. If a proxy or service refused that stream, Hades never automatically called the otherwise usable data API. Ordinary remote edits and deletions could remain stale indefinitely.

Hades now falls back to the existing scoped snapshot/changes reconciliation after non-authorization streaming failures. Cache rows and checkpoints still commit atomically. A generation-bound cooldown covers both failed stream catch-up and fallback attempts, preventing a second request in the same tick or a retry within 30 seconds after failure. Concurrent ticks keep one owned background operation. This is a minimum retry interval while Hades is running, not a promised hosted real-time latency.

Polling during an outage keeps the interrupted-update explanation. Hades shows live updates only after an active stream has caught up successfully. Revocation and authorization denial disable access; pause, shutdown, disconnect and account replacement fence late results. Successful polling cannot turn a revoked connection into an authorized one. The five other providers retain their existing polling/change contracts and data coverage from [v3](ACCEPTANCE_V3.md).

Independent testing reproduced an immediate duplicate request after successful stream headers followed by failed catch-up. That was repaired before acceptance. Normal stream lifetime rotation can settle as EOF or timeout; both must retire the old watch and recover with one owned replacement, without requiring an unnecessary data request on EOF.

## Read the actual framework and its references

The bundled Company OS capability-assignment skill requires a **2,137,476-byte catalog** that the old skill-only reader could not access. The bundled **27,226-byte Emil design skill** also exceeded the tool's fixed 24,000-byte limit. Both remain the actual canonical framework files; no replacement catalog or design guidance was invented.

The existing `company_os_read` tool now supports:

- `{}`: the existing skill inventory.
- `{ "skill": "company-os/ui-design-quality/vendor/emil-design-eng/SKILL.md" }`: one complete skill, up to 64,000 bytes. The initial system-context injection keeps its existing budget.
- `{ "resources": true, "prefix": "company-os/assign-capability-skills/", "limit": 50 }`: bounded discovery of retained resource paths and file hashes.
- `{ "resource": "references/capability-catalog.json", "from": "company-os/assign-capability-skills/SKILL.md", "maxBytes": 32768 }`: a text page resolved against the actual source skill. Continue with `nextCursor` and the same resource/from arguments.

Every resource page identifies the framework release, canonical path, file and chunk hashes, byte offset, total size and completion state. UTF-8 boundaries preserve the exact source bytes. Changed release, file, profile, operation or catalog prefix refuses a previous continuation. Pages from an incomplete JSON document are explicitly incomplete text, not a parsed complete catalog. Relative paths resolve only to files already present in the verified bundle; arbitrary host paths and URLs are unavailable.

Scripts can be inspected as retained text. Reading does not extract or execute them, start controllers or alter Hades permissions. The profile toggle and cancellation are checked on every invocation, including retained tools. The real Workbench conversation path forwards the complete design skill into the next model request without silently clipping it.

The framework remains bundled Company OS **0.6.0**, canonical source `mosnin/companyos@5b374ba2066332c44f74eafddab4f8f575715ba3`, with 688 verified files. Existing fixed-registry update, rollback and profile controls remain. Newest public npm availability, publication, actual Bun execution and framework controllers are not accepted by these resource tests.

## Local provider delivery

Previously tested provider files were compared against their retained source hashes before selective local commits. Their original branch tips remain available. No remote push, schema migration, deployment or operator registration was run.

| Product | Actual repository | Local branch | Local commit |
| --- | --- | --- | --- |
| Operate | `mosnin/Clickup` | `codex/hades-plugins-oauth` | `db0344050e4058f8956446748a4e075debd38b7d` |
| Company OS SaaS | `mosnin/company-os-web` | `codex/hades-plugins-oauth` | `3992fe67c0b7fafeffeb14642c68fd374f0fd7cb` |
| Govern | `mosnin/agentid` | `codex/hades-plugins-oauth` | `4405bb13a387b37dd0ef1748cb89c6ca777e7c43` |

Operate includes its 21 receipt-bound files; Govern includes 15 Hades OAuth/source/fixture/report files. Company OS includes 22 receipt-bound files plus its six-case independent review fixture. Its 41 unrelated design/package/output files were preserved byte-for-byte and excluded. Operate and Govern were clean after their commits; Company OS intentionally retains that unrelated work.

Scalar and Cadre retain their accepted local commits from v3. Glove remains mixed with unrelated work in its existing checkout and was not committed by this delivery pass. Stored remains the retained source patch; its earlier remote write was denied. None of these states establishes a deployed provider revision.

## Verification and remaining gates

The final candidate passes `npm run test:plugins`: **303/303 in 21 files**, and `npm run test:work:offline`: **296/296 in 29 files**. The runners share 11 routing cases in one file, giving **588 distinct cases across 49 files**. Full TypeScript and both desktop source bundles pass. Native GUI, actual Orca/provider execution and installed-app acceptance are separate gates.

The final Plugins total includes 13 new author stream-fallback cases, three independent stream challenges, 32 new resource cases and one new Workbench conversation case. Earlier focused/repeated runs are subsets and are not added again. The first whole-project type check caught two optional-validator calls in the new test code; these were corrected without changing production behavior, then types and the complete Plugins gate were rerun successfully.

[Independent review](SYNC_FRAMEWORK_V4_REVIEW.md) records the reproduced streaming defect, its repair and the resource boundary inspection. [source-v4-receipt.json](source-v4-receipt.json) binds the exact source, final commands, provider delivery and captured logs. The [resource author receipt](company-os-resources-v4-receipt.json) retains its prior and corrected test hashes. Historical red and green logs remain distinct under [evidence](evidence/).

Required live acceptance remains **0/7**: real account consent and native callback, browse, agent read, approved conditional write, observed sync, refresh and revoke/disconnect in the installed Hades application. Native Keychain, UI interaction, provider deployment, database migrations and production streaming behavior remain open. Source and injected-transport tests do not satisfy those gates. The broader Helm enterprise program also remains open.
