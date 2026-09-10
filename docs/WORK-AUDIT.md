# Local Work audit journal

`src/desktop/core/work-audit.ts` accepts a caller-owned `DatabaseSync`. The journal never closes that connection or starts/commits an outer transaction. Each append uses an internal savepoint. The caller must transact its authoritative goal mutation and audit append together, commit before emitting UI changes, and roll back on either failure. An append returned from an outer transaction is provisional until that transaction commits.

This is local integrity evidence, not cloud tenancy, RBAC, cryptographic authenticity, tamper-proof storage, proof of user identity, or independent acceptance of the work. A database administrator can remove triggers or rewrite the entire chain. Verification detects that only when the expected head is independently retained and trusted. Hashes can expose equality and permit guessing low-entropy inputs; they do not encrypt snapshot contents.

## Stable contract

```ts
const audit = new WorkAuditJournal(db);
const scope = { goalId: goal.id, profile: goal.profile, root: goal.root };
// root is caller-authorized/canonicalized. The journal checks lexical absolute
// normalization, not filesystem identity, symlinks, permissions or user authority.
db.exec("BEGIN IMMEDIATE");
try {
  // Read current revision and BEFORE snapshot inside this transaction.
  // Apply authoritative mutation with its normal ownership/revision predicate.
  audit.append({
    scope,
    transitionId: `${goal.id}:${nextRevision}`, // stable source transition identity
    actor: { kind: "system", id: "work-runtime" },
    kind: "goal.updated", // symbolic event code, not freeform prose
    taskId, attemptId, // optional existing IDs, never an answer/error/prompt
    at: Date.now(), revision: nextRevision,
    before, after, // first event omits before; later events must match prior after
    metadata: { status: after.status, taskCount: after.tasks.length },
  });
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
// Publish changed state only after COMMIT.
```

- Scope is `{goalId, profile, root}` and immutable for a given goal. IDs and actor/kind references are bounded symbolic strings. Scope is a selection/integrity boundary, not authorization.
- `append` returns `WorkAuditEvent`. Sequence is contiguous and monotonic **per goal**, starting at 1; it is not a global event ordering. `revision` must increase but may skip lease-only database revisions. Timestamps are caller-provided nonnegative safe integers, not trusted clocks.
- `transitionId` is unique per goal; duplicate transitions fail with `duplicate_transition`. The caller must reuse that ID on retries, not generate a fresh identity for the same source transition. Duplicate source revisions also fail.
- `before`/`after` must be plain JSON-compatible snapshots carrying matching `id`, `profile`, `root`. Undefined object properties are omitted; arrays with undefined/holes, cycles, accessors, non-finite numbers and unsupported values refuse. `before` may be undefined only at genesis. Imported legacy goals need an explicit genesis/baseline event; this does not claim earlier history was audited.
- Snapshot bodies are never persisted. SHA256 uses recursively sorted object keys and JSON primitives. Limits: 4 MiB snapshot representation, 100000 nodes, depth 40. Metadata accepts only `status`, symbolic `reasonCode`, and nonnegative safe integer `taskCount`, `tokens`, `reservedTokens`. Unknown keys and arbitrary prose refuse. IDs/reason codes are not a secret detector; callers must never encode credentials or prompts in them.
- Event body contains scope, sequence, transition/actor/task/attempt references, timestamp/revision, snapshot hashes, metadata and previous event hash. Its canonical SHA256 is `hash`; genesis predecessor is 64 zeroes. Full prompts, answers and credentials have no default journal fields.
- SQLite triggers refuse UPDATE/DELETE on events and scopes, replacement through uniqueness conflicts, noncontiguous insertion, revision regression, inconsistent predecessor/snapshot fields, and inconsistent JSON scope/column identity. API checks canonical hashes. Triggers are not protection against a database owner changing schema.

## Inspection, pagination and export

`head(scope)` returns `{scope, sequence, hash}`. `read` and `export` are equivalent structured, read-only page methods:

```ts
const frozen = audit.head(scope);
const page = audit.export(scope, {
  afterSequence: 0, limit: 100, expectedHead: frozen,
});
// {schema:"hades.work-audit.v1", scope, predecessor, events, end, head, hasMore}
```

Pass the original `expectedHead` on every subsequent page; use `page.end.sequence` as the next cursor. New appends do not change that frozen export. A missing/changed frozen head, cursor beyond head, cross-scope access, corrupt canonical event, altered SQLite columns, missing events, oversized input or bad limit fails. Default page size 100; maximum 500 events and 1 MiB canonical export. The module does not create files or choose an export destination; caller UI/RPC performs authorized file writes.

`verifyWorkAuditExport(value, {scope, head, predecessor?})` is pure and requires the exported end to equal the independently supplied expected head. It defaults the starting predecessor to genesis. It refuses a page advertising `hasMore` or ending before that head. For a suffix, supply its independently known predecessor explicitly. A partial page cannot prove a later head; do not relabel it verified. For exports longer than one page, use `verifyWorkAuditBundle` below. Combining events into a single page is supported only within the same 500-event/1 MiB bound. Carrying a head inside the export is not independent trust.

`verifyWorkAuditBundle(value, {scope, head})` accepts `{schema:"hades.work-audit-bundle.v1",scope,head,pages}` with one to ten pages, at most 500 events per page and 8 MiB for the full canonical bundle. Its head may include the matching scope returned by `journal.head`. Each page must carry the same frozen head, predecessors must be contiguous from genesis, and the final page must reach the independently supplied head. Missing middle/start/final pages, reordering, inconsistent continuation flags, extra terminal pages, changed self-declared heads and cross-page snapshot/revision/transition discontinuity refuse. Only a zero-event goal may have one empty page. No arbitrary suffix is accepted as a complete bundle.

The verifier checks exact scope, event hashes, sequence ordering, no missing events, unique transitions within the verified range, snapshot/revision continuity, predecessor and final head. Anchored suffix verification checks first-event linkage to the trusted predecessor hash; the supplied anchor represents trust in earlier history. Unknown fields and malformed data fail. It returns the verified scoped head; it never returns an acceptance verdict about task output.

UI should label the journal “Local integrity journal,” show event kind/actor/task/attempt/time/revision and safe metadata, disclose frozen head and range, and distinguish unverified page, verified against a retained head, and incomplete history. Never display “tamper-proof” or “authenticated” from these hashes.

## Validation

Sixteen focused SQLite tests exercise atomic goal/audit rollback (including genesis scope), append savepoint rollback, duplicate transitions, revision gaps/regression, immutable scope, cross-profile/root refusal, SQL UPDATE/DELETE/REPLACE attempts, frozen pagination, anchored suffix verification, modified/reordered/missing events, truncated head, altered SQL shadow fields, metadata/snapshot bounds, secret-body omission and complete multi-page bundles (including missing/reordered pages and changed self-declared heads). No native UI, provider, network or cloud permissions are exercised. Integration must additionally test the real DurableWork mutation/notification paths; this module cannot audit mutations its caller fails to append.
