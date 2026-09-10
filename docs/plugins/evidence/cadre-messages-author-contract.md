# Hades conversation and task-output source contract

2026-09-10. Local source candidate, frozen after 56 author-run checks, 9 independently authored SQL checks, and clean core/API TypeScript checks. The separate independent report is [HADES_MESSAGES_INDEPENDENT_REVIEW.md](../docs/reports/HADES_MESSAGES_INDEPENDENT_REVIEW.md). This receipt does not establish hosted migration, native consent, or production delivery.

## Scope and actual records

The new OAuth scope is `messages:read`. An existing grant does not acquire it through refresh; the person must approve new consent. The consent label is **Read your conversations and task outputs**. This wording describes the existing Message records and their real Task/Run relationships. There is no `Task.result` field and this change creates no execution, cancel, or message-writing operation.

The existing client remains `hades-desktop-cadre` with native callback `ai.hades.desktop:/oauth/cadre`. The current product issuer is configured as `https://cadre.to`; these local fixtures do not establish hosted endpoint availability.

The `messages` collection returns the common record shape:

```ts
{
  id: string;
  collection: "messages";
  title: string; // First 160 characters of permitted text.
  updatedAt: number; // Message.createdAt, in milliseconds.
  revision: string;
  data: {
    threadId: string;
    seq: number;
    role: "user" | "bot";
    text: string;
    botId?: string;
    groupId?: string;
    runId?: string;
    taskId?: string;
    runStatus?: string;
    runStartedAt?: string;
    runCompletedAt?: string;
    conversationName?: string;
  };
}
```

`text` joins the permitted Message text blocks with newlines. `conversationName` comes from the actual current bot/group name. Run and task fields are included only when their real relations exist and pass current authority checks. Message has no `updatedAt` column: the common envelope uses its actual creation time. `revision` changes with the durable projection, including relevant parent updates; the timestamp is not an edit timestamp.

## Read API and pagination

| Request | Response and conditions |
|---|---|
| `GET /api/hades/records?collection=messages` | `{records, cursor, nextPage?}` |
| Same with `threadId`, `taskId`, or `runId` | Filters apply together and require the messages collection. |
| `GET /api/hades/records?collection=messages&id=...` | `{record, cursor}` or `not_found`; `id` plus `page` is rejected. |
| `GET /api/hades/records?collection=...&id=...` | Also supports current-authorized bots, tasks, and spaces under their corresponding read scopes. |
| `GET /api/hades/changes?collection=messages&cursor=...` | `{changes, cursor, hasMore}`; no direct-id or thread/task/run filters. |

Continuation is the opaque `page` value from `nextPage`; callers must preserve the exact filters. The v2 token binds its baseline watermark, position, and filter identity. Record pages use stable collection/id ordering; `data.seq` provides message order within a thread. Pages are not returned in transcript chronology. Existing metadata-only pagination remains compatible with its prior path.

At most 100 candidate rows are consumed per page, with a 101st lookahead. Serialized pages have a 2 MiB budget, including an 8192-byte reserve for the envelope and continuation token. A serialized individual value has a 512 KiB cap; permitted text has a 64,000 UTF-8 byte cap. SQL withholds a sanitized own-block representation larger than 262,144 bytes and returns an explicit capacity marker. Source callback classification returns at most two distinct recognized result/status markers; row receipt classification returns at most two receipt kinds, without arbitrary source content.

The cursor advances only through consumed rows, including hidden rows. A visible row that would exceed the page byte budget remains available on the next page. An empty filtered page can still have a continuation. A single oversized permitted record fails with `record_capacity_exceeded` rather than truncated content. Oversized hidden system, receipt, and internal-peer content is classified before that failure, so it does not block unrelated public results.

## Visibility, authority, and history

The reader uses the existing `message-visibility.ts` helpers and current Run/source-Message relations, including a source receipt outside the current page. Result/status callbacks retain their existing user-facing meaning. System messages, peer receipt rows, and internal-peer output are excluded. Human-input/action cards remain in Cadre; their adjacent internal prose is not exposed by this text-only API. Raw Message blocks, secret answers, tool payloads, peer bodies, attachment URLs, runtime errors, checkpoints, and execution credentials are not returned.

One SQL statement reads the current grant, scopes, membership, parent relations, current content, and watermark. Threads require the current actor and space plus an active owned bot, or an active owned group with at least two active owned agents. Message, Run, Task, source-Message, and bot relationships must remain within the authorized actor/space/thread. Current archive, transfer, membership withdrawal, scope removal, or deletion can withdraw an earlier visible record.

Durable message history stores identifiers and parent metadata, never Message text or raw blocks. Reading a historical event rehydrates the currently authorized content; an unavailable or newly hidden row yields a safe deletion. This is a feed of current authorized records, not an immutable archive of historical message content. Source-receipt edits also invalidate affected output projections.

The additive `20260910010000_hades_messages` migration provides projection functions and triggers. The earlier `20260910000000_hades_oauth` migration is unchanged. Narrow parent trigger columns avoid rewriting the entire conversation for ordinary Thread sequence/unread changes. Trigger wrappers use owner authority with a fixed search path and schema-qualified helpers, while direct helper invocation stays denied to ordinary authenticated roles. Relevant parent updates can still touch their associated messages; production backfill, lock, and workload behavior needs its own database gate.

## Verification and provenance

```sh
HADES_REVIEW_NODE_MODULES=/path/to/existing/node_modules node scripts/run-hades-messages-review.mjs
HADES_REVIEW_NODE_MODULES=/path/to/existing/node_modules node scripts/run-hades-messages-independent-review.mjs
./node_modules/.bin/tsc -p packages/core/tsconfig.json --noEmit --incremental false --pretty false
./node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit --incremental false --pretty false
```

The explicit runners refuse missing or mismatched dependencies and do not install packages. They use retained Vitest 4.1.5 (MIT) and PGlite 0.4.1 (Apache-2.0). The project declares Vitest `^4.1.10`, so this retained test runtime is an explicit version difference. Type checks used the project's existing TypeScript 5.9.3 (Apache-2.0). Project package manifests and root LICENSE identify Apache-2.0.

Final author run: **56/56**, comprising 16 message SQL/visibility/pagination cases, 29 retained provider cases, and 11 shared visibility cases. The separate independent reviewer ran **9/9** unchanged cases at the same repaired hashes; an author rerun also passed those nine. Both type checks exited 0 and `git diff --check` passed. The fixtures execute both actual migrations with PGlite on a minimal compatible schema; they do not run the complete production schema or generated Prisma client.

Retained red/green evidence covers a 4,441,127-byte response and invalid detail/page combination, then the independent unbounded source-intent representation and oversized hidden-peer denial. The repaired reader bounds serialized pages without skipping later records, SQL emits bounded classification markers, and hidden content is classified before capacity failure. The independent report preserves its original failing evidence and repaired acceptance.

| Frozen production artifact | SHA-256 |
|---|---|
| `packages/core/src/node/hades-messages.ts` | `da91a1d32a255de9674eba3a446af96f5a8e709992cbd25ac3c7e1b59c213b74` |
| `packages/db/prisma/migrations/20260910010000_hades_messages/migration.sql` | `0a84aa0cec8343250dfbcbbb58874b3eda14ee706b27a6dd0528c5e2ad5dbcb7` |
| `packages/core/src/node/hades-oauth.ts` | `5b22d3137104189838c14477db33881cd9550c63a1c34eed52e1d83d1c0c7096` |
| `apps/api/src/hades-oauth.ts` | `caace5ba22341e8813f744410d90190f0c766d2587ed439414795ead795aad78` |
| Retained OAuth migration | `148f07dbb2bd776fbb46b110d47e429fa10e58801614f44fe9689cb1c3d4e587` |

The candidate requires applying the additive migration and serving the changed routes before it can be used outside these tests. Full-schema database behavior, multi-connection contention, native human consent, deployed delivery, and production-scale resource use remain open. No live provider request, listener, native launch, installation, remote write, commit, or deployment was performed for this source slice. Broader raw business exports, attachments, secret/action cards, message editing, and task execution control are outside this read scope.
