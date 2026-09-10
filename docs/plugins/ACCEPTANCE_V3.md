# Plugins data expansion and durable Work — source checkpoint

2026-09-10. This adds to the local Hades source at `b6ec8b860252b34eefc80e0914bc1d1393eefb6a`. It does not replace the historical [v2 receipt](ACCEPTANCE_V2.md), accept an installed application, or close the active enterprise goal. **Zero of seven live account journeys are accepted.**

## Connected account behavior

`plugins_read` now refreshes the connected service before returning its first page. A failed refresh is an error; saved data requires explicit `freshness: "cached"`. Continuation supplies the returned `snapshotId` as `expectedSnapshotId`. That identity binds the actual saved contents, profile, connection generation, account, grant and query. Unchanged refreshes retain it; changed data or authority refuses the old continuation. This binds the local reading session, not a claim that a remote multi-page API supplies a transactionally frozen snapshot.

Cancelled readers stop waiting even if they joined a separately owned background sync. Removing agent read access prevents late data return. Large records remain discoverable: list pages keep their identities and point to `plugins_record`, which retains its existing full-content chunk/hash contract. No record bytes are silently cut into a purported complete result.

All seven adapters validate their actual write acknowledgements. Record-based providers must return the exact requested record, collection, applied state and valid revision; native providers also return the original key. Operate and Company OS use their actual versioned response envelopes. Empty, contradictory or mismatched success bodies remain unknown after dispatch, with the same durable key retained across restart. This does not prove the remote effect failed, and it does not authorize another attempt.

## Expanded product coverage

| Product | Added readable data | Added edits | Source transport |
| --- | --- | --- | --- |
| Scalar | Contacts, companies, activities, pipelines and pipeline entries, including full notes, descriptions, activity bodies and linked identities | Contact descriptive fields/tags; company descriptive fields/tags; pipeline stage, deal score and conversation state | Complete bounded reconciliation through five collection queries; polling, no server change checkpoint |
| Cadre | Current user-facing conversation text, linked task/run/thread identities and permitted run status/times; full record detail | No new message/task execution effect | Durable metadata changes, with current authorized content rehydrated at read; polling |

Scalar reuses its existing disclosed CRM read/write consent. Cadre messages require the new `messages:read` consent; old grants cannot silently gain conversation access. Cadre's real shared visibility policy excludes internal peer/tool messages and secret-input cards. Current thread, agent, task, run and group ownership are checked before detail or historical data is returned. It does not invent a `Task.result` field.

Scalar rejects empty detail/page identities, checks current target ownership even on replay, and binds conditional updates to the observed revision and projected fields. Cadre pages use a serialized byte budget in addition to a row count, preserving progress through hidden rows without skipping the next visible record. SQL peer classification is bounded to recognized markers; hidden oversized peer content cannot block valid public results.

The account UI uses readable collection labels, including “Pipeline entries,” while preserving source collection IDs in requests. The existing reading view and All fields controls display the expanded records. Native visual/keyboard acceptance remains open.

Material coverage gaps remain: additional Scalar communication histories/segments/workflows and creation/deletion; Stored PostgreSQL conditional writes; Govern audit and operational policy editing; Cadre task execution and non-text artifacts; private recording playback. The other five provider source surfaces and actual Company OS framework/update integration remain as documented in v2. Neither the framework's newest published version nor Bun execution is accepted.

## Durable Work integration

Tasks default to Hades. Users may explicitly select Orca with Codex, Claude or Helm as its coding engine. The visible engine label is Helm; Orca's internal `opencode` identifier remains unchanged. Work persists the dispatch identity before calling the existing Orca service. Recovery observes the same intent instead of replaying it. Unknown usage remains reserved; process exit alone cannot complete a task or release dependents.

An unavailable Orca artifact now affects only that task: independent Hades siblings continue, with no Orca attempt or token reservation allocated. Stop targets retained identities within the current project/profile. See [the independent Work review](../research/helm-enterprise-2026-09-10/audit/work-orca-independent-review.md).

This source boundary is not packaged Orca execution. Actual Orca worktree review/integration, explicit terminal retry, provider budget enforcement, native recovery and a real long-running team trial remain open.

## Verification

Run `npm run test:plugins` and `npm run test:work:offline`. Both use retained local dependencies and explicitly injected model/transport boundaries. They do not install packages, open listeners, control apps, contact providers or deploy services. The existing listener-based Work integration suite is preserved separately and was not run through an alternate network path.

- Plugins: **247/247** in 18 files, including 46 independent fresh-read/Scalar/write-acknowledgement cases.
- Work/Orca: **127/127** in 16 files, including the six independent dispatch/fairness/recovery challenges and two default-engine Workbench workflows.
- Full TypeScript: exit 0 with `tsc --noEmit --incremental false`.
- Desktop source build: sidecar and frontend pass; this is not a GUI/native application build.
- Scalar: 26 author fixtures and 7 distinct independent fixtures pass; focused strict types pass. Generated Prisma/real PostgreSQL and whole-project dependency compatibility remain open.
- Cadre: 56 author fixtures (16 new message, 29 prior provider, 11 shared visibility) and 9 distinct independent SQL fixtures pass; core and API types pass. Actual migrations run in a minimal PGlite schema; full production schema, hosted concurrency and migration delivery remain open.

Independent receipts: [fresh reads](FRESH_READ_REVIEW.md), [Scalar client and all-provider writes](SCALAR_CLIENT_V2_REVIEW.md), and retained provider reports under [evidence](evidence/). [source-v3-receipt.json](source-v3-receipt.json) binds current files, source identities and exact logs. Earlier failed fixtures and repairs remain recorded separately.

## Delivery gates

The reviewed provider source is committed locally in `mosnin/Sicarii` on `codex/hades-plugins-crm-v2` at `542aea19d5bfbca44b998a6342fc69a0359e6b7b`, and in `mosnin/cadre` on `codex/hades-plugins-messages` at `81188b66656053de979010218044445f7856bc07`. Both working trees were clean after their selective commits. Their unrelated starting branches and prior commits were preserved. Hades' follow-up source is bound by the v3 file receipt; the other provider delivery states remain as recorded in v2.

No remote provider release, npm publication, installed Hades revision or live OAuth account is claimed. Source must still be delivered to the owning provider release branches, migrations/clients provisioned and verified, and all seven sign-in → browse → agent read → approved write → observed sync → revoke journeys completed in the installed app. Current native and remote-write approval restrictions, absent runtime dependencies and insufficient native-build disk space remain recorded in [PROGRAM.md](PROGRAM.md). No denied operation was retried through another tool.
