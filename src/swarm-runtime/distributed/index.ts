/**
 * @module swarm-runtime/distributed
 *
 * The multi-node layer: everything required to run one logical swarm across
 * more than one machine, with the SAME trust properties the single-machine
 * swarm has (real verification gate, real ed25519 certificates, exactly-once
 * accounting).
 *
 * Layering, bottom up:
 *
 *  1. `membership`        — SWIM-style gossip membership + leader election.
 *  2. `lease-ledger`      — fencing-token leases and the exactly-once,
 *                           certificate-gated verified-result ledger.
 *  3. `federation-link`   — one authenticated, signed, sequenced, replay-proof
 *                           duplex link to one peer.
 *  4. `federation-router` — the per-machine fan-out over those links: gossip
 *                           broadcast, task offers, federated result delivery.
 *  5. `cluster-node`      — the per-machine executor: joins membership and
 *                           runs leased tasks on a REAL local `SwarmManager`.
 *  6. `cluster-coordinator` — the leader's scheduling brain: placement,
 *                           leases, reassignment, exactly-once verification.
 *  7. `cluster-autoscaler`  — desired-worker-count control across the real
 *                           remote-compute backends.
 *  8. `cluster-chaos` / `cluster-bench` — a real in-process fabric that
 *                           composes all of the above, deterministic fault
 *                           injection, and the measured multi-arm benchmark.
 *
 * Nothing in here is a simulation of verification: a task is "verified" only
 * once a real gate accepted it and a real ed25519 certificate binds the exact
 * bytes that were produced.
 */

export * from "./membership";
export * from "./lease-ledger";
export * from "./federation-link";
export * from "./federation-router";
export * from "./cluster-node";
export * from "./cluster-coordinator";
export * from "./cluster-autoscaler";
export * from "./cluster-chaos";
export * from "./cluster-bench";
