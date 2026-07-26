/**
 * @module hades/state
 *
 * The shared workspace store: one durable, hash-chained, CRDT-merged view of
 * the agent's sessions / memory / config / skills that every surface (the
 * `hades state` CLI, the desktop app's `state.*` IPC lane, and anything
 * added later) reads and writes concurrently and safely.
 *
 *  - `record.ts` — the pure record algebra (canonical JSON, vector clocks,
 *    deterministic merge, actor identity).
 *  - `store.ts`  — the durable multi-process store (atomic segment writes,
 *    hash-chained journal, cross-process locking, corruption quarantine).
 *  - `feed.ts`   — an ordered, gap-free, cursor-persisted change feed.
 *  - `sync.ts`   — bidirectional reconciliation with honest conflict reporting.
 *  - `domains.ts`— adapters binding the store to the REAL engine stores.
 *  - `wiring.ts` — the one place surfaces assemble the stack (stable actor
 *    identity, shared root).
 */
export * from "./record";
export * from "./store";
export * from "./feed";
export * from "./sync";
export * from "./domains";
export * from "./wiring";
