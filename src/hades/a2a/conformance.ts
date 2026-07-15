/**
 * Reusable A2A transport conformance battery.
 *
 * Any {@link A2ATransport} implementation must satisfy these checks. Running the
 * same battery against both {@link InMemoryA2ATransport} and
 * {@link RemoteA2ATransport} proves the two share identical delivery semantics —
 * the remote (cross-process, serialized) transport is a drop-in for the in-memory
 * one.
 *
 * Pure library code: no test framework is imported. Each check returns a
 * {@link ConformanceResult} so a caller (a vitest file, a CLI, whatever) can
 * assert on them.
 */
import { AgentEndpoint } from "./bus";
import type { A2ATransport } from "./bus";
import type { A2AMessage } from "./types";

export interface ConformanceResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/** Collect the ids delivered to an endpoint's inbox, in arrival order. */
function collector(ep: AgentEndpoint, sink: string[]): () => void {
  return ep.on((m: A2AMessage) => sink.push(m.id));
}

/**
 * Run the full battery against a fresh transport built by `makeTransport`. Every
 * check gets its own transport so state cannot leak between checks. Returns one
 * {@link ConformanceResult} per check.
 */
export async function runA2AConformance(
  makeTransport: () => A2ATransport
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];

  // (1) Direct delivery reaches only the addressed agent.
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });
    const c = new AgentEndpoint({ agentId: "c", team: "x" }, t, { idPrefix: "c", now: () => 1 });
    const bSeen: string[] = [];
    const cSeen: string[] = [];
    collector(b, bSeen);
    collector(c, cSeen);
    await a.emit(b.address, { hi: true });
    const ok = bSeen.length === 1 && cSeen.length === 0;
    results.push({
      name: "direct delivery reaches only the addressed agent",
      ok,
      detail: ok ? undefined : `b saw ${bSeen.length}, c saw ${cSeen.length}`,
    });
  }

  // (2) Broadcast reaches all team members, not the sender.
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });
    const c = new AgentEndpoint({ agentId: "c", team: "x" }, t, { idPrefix: "c", now: () => 1 });
    const aSeen: string[] = [];
    const bSeen: string[] = [];
    const cSeen: string[] = [];
    collector(a, aSeen);
    collector(b, bSeen);
    collector(c, cSeen);
    await a.broadcast({ ping: true });
    const ok = aSeen.length === 0 && bSeen.length === 1 && cSeen.length === 1;
    results.push({
      name: "broadcast reaches all team members, not the sender",
      ok,
      detail: ok ? undefined : `a=${aSeen.length} b=${bSeen.length} c=${cSeen.length}`,
    });
  }

  // (3) Team-scoped broadcast excludes other teams.
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });
    const z = new AgentEndpoint({ agentId: "z", team: "y" }, t, { idPrefix: "z", now: () => 1 });
    const bSeen: string[] = [];
    const zSeen: string[] = [];
    collector(b, bSeen);
    collector(z, zSeen);
    await a.broadcast({ ping: true }, { team: "x" });
    const ok = bSeen.length === 1 && zSeen.length === 0;
    results.push({
      name: "team-scoped broadcast excludes other teams",
      ok,
      detail: ok ? undefined : `b(team x)=${bSeen.length} z(team y)=${zSeen.length}`,
    });
  }

  // (4) No self-echo on direct (a message addressed to the sender is not delivered).
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const aSeen: string[] = [];
    collector(a, aSeen);
    await a.emit(a.address, { self: true });
    const ok = aSeen.length === 0;
    results.push({
      name: "no self-echo on direct send",
      ok,
      detail: ok ? undefined : `sender saw ${aSeen.length} of its own message(s)`,
    });
  }

  // (5) Unsubscribe (endpoint.close) stops delivery.
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });
    const bSeen: string[] = [];
    collector(b, bSeen);
    b.close();
    await a.emit(b.address, { hi: true });
    const ok = bSeen.length === 0;
    results.push({
      name: "unsubscribe (close) stops delivery",
      ok,
      detail: ok ? undefined : `closed endpoint still saw ${bSeen.length} message(s)`,
    });
  }

  // (6) Per-link FIFO order for a burst of N direct messages.
  {
    const t = makeTransport();
    const a = new AgentEndpoint({ agentId: "a", team: "x" }, t, { idPrefix: "a", now: () => 1 });
    const b = new AgentEndpoint({ agentId: "b", team: "x" }, t, { idPrefix: "b", now: () => 1 });
    const bSeen: string[] = [];
    collector(b, bSeen);
    const N = 50;
    for (let i = 0; i < N; i++) await a.emit(b.address, { seq: i });
    // Ids are minted by the sender's factory as `a-1`, `a-2`, ... in send order.
    const expected = Array.from({ length: N }, (_, i) => `a-${i + 1}`);
    const ok = bSeen.length === N && bSeen.every((id, i) => id === expected[i]);
    results.push({
      name: "per-link FIFO order for a burst of direct messages",
      ok,
      detail: ok ? undefined : `got ${bSeen.length}/${N}, order match=${bSeen.join(",")}`,
    });
  }

  return results;
}
