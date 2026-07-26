/**
 * @module hades/dataset
 *
 * The verified-trajectory data flywheel — the loop that lets the agent get
 * better from its own *gate-verified* experience instead of from raw logs.
 *
 * The pieces, in dependency order:
 *
 *  1. **`./corpus`** — {@link VerifiedTrajectoryCorpus}: a durable,
 *     append-only, SHA-256 hash-chained, cross-process-locked JSONL ledger
 *     that admits ONLY trajectories which pass the real
 *     `verifyTrajectoryForSynthesis` gate AND an independent recomputation of
 *     the trace hash and the certificate payload bindings. A rejected
 *     trajectory changes nothing observable — not `size()`, not `head()`, not
 *     the byte length on disk — so "an unverified trajectory is provably
 *     excluded" is a mechanical property, not a claim.
 *  2. **`./example`** — the pure training-example encoder: three wire schemas
 *     (`sft-prompt-completion` / `chat-messages` / `tool-trace`), secret
 *     redaction over every text field, untrusted-content fencing (forged role
 *     markers, control characters, lone surrogates), grapheme-safe truncation,
 *     and a pure sha256-bucket train/holdout split (no RNG, so the split is
 *     stable across machines and reruns).
 *  3. **`./exporter`** — {@link exportDataset}: a byte-reproducible sharded
 *     export (deterministic gzip with the RFC1952 MTIME/XFL/OS bytes zeroed,
 *     a canonical hash-pinned manifest, tmp-dir + rename atomicity with
 *     rollback). Two exports of the same corpus produce the same digest and
 *     byte-identical shards regardless of clock, admission order or outDir.
 *  4. **`./audit`** — {@link auditDataset}: the trust-nothing independent
 *     auditor. It re-hashes every shard (raw and stored), re-decodes every
 *     record, recomputes every record id and split, recomputes the dataset
 *     digest, and — given a real corpus — re-verifies every ed25519
 *     certificate and re-derives every trace hash. {@link computeStats}
 *     reports honest, non-extrapolated statistics over what is actually on
 *     disk.
 *  5. **`./finetune`** — the local fine-tune loop, INERT by default: real
 *     magic-byte model detection, a pure deterministic plan whose `argv` is
 *     always a `string[]` (never a shell string), and a five-way ANDed safety
 *     gate that must all hold before any trainer process is spawned. No loss,
 *     accuracy or perplexity is ever synthesized — the outcome variants have
 *     no field to fabricate one into.
 *
 * The terminal surface over all of this is `hades dataset`
 * (`../cli/dataset-command`, wired to the real engine by
 * `../cli/dataset-deps`).
 */

export * from "./corpus";
export * from "./example";
export * from "./exporter";
export * from "./finetune";

// `./audit` is re-exported explicitly rather than with `export *` for exactly
// one reason: it re-exports `ExampleSchema` (it needs the type in its own
// public signatures), which would collide with `./example`'s original
// declaration under two `export *`s. Everything else `./audit` owns is listed
// here; importing `./audit` directly is unchanged.
export { auditDataset, readDatasetRecords, computeStats, formatAuditReport, formatStatsReport } from "./audit";
export type { AuditCode, AuditFinding, DatasetAuditReport, AuditOptions, Histogram, DatasetStats } from "./audit";
