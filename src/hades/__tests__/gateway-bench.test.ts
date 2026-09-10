import { describe, it, expect } from "vitest";

import { runGatewayBench, formatGatewayBenchReport, type GatewayBenchReport } from "../gateway/gateway-bench";

import { InMemoryIdentityStore, IdentityLinker, ContinuityRouter } from "../gateway/continuity";
import { InMemoryTrustStore } from "../gateway/trust-store";
import { PairingGuard } from "../gateway/pairing";
import { BadgeStamper, type BadgeEvidence } from "../gateway/badge";
import { AgentGatewayHandler, echoEngine } from "../gateway/agent-handler";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function frozenClock(t = 1_700_000_000_000): () => number {
  return () => t;
}

// ---------------------------------------------------------------------------
// The happy-path script
// ---------------------------------------------------------------------------

describe("runGatewayBench", () => {
  it("proves one user keeps one conversation from telegram to email", async () => {
    const report = await runGatewayBench({ now: frozenClock() });

    expect(report.platforms.sort()).toEqual(["discord", "email", "signal", "slack", "telegram", "whatsapp"].sort());
    expect(report.turns).toBe(2);
    expect(report.pairedHandles).toBe(2); // telegram handle + email handle
    expect(report.identities).toBe(1); // merged into one identity via /link
    expect(report.sessionIds).toHaveLength(1); // one distinct session id across both turns
    expect(report.crossPlatformContinuity).toBe(true);
    expect(report.switchedChannelFlagged).toBe(true);
    expect(report.honest).toEqual({ engineMode: "mock", transports: "fake" });
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("badges tally matches the stamped output: every reply in this mock-engine script is honestly 'unverified' (no gate evidence exists to promote it)", async () => {
    const report = await runGatewayBench({ now: frozenClock() });
    expect(Object.keys(report.badges)).toEqual(["unverified"]);
    // 5 non-empty stamped replies: /pair confirm, turn 1, /link issue, /link
    // redeem confirm, turn 2. Nothing in the script produces an empty reply.
    expect(report.badges.unverified).toBe(5);
  });

  it("is deterministic under a fixed injected clock: two independent runs produce a deeply-equal report", async () => {
    const r1 = await runGatewayBench({ now: frozenClock() });
    const r2 = await runGatewayBench({ now: frozenClock() });
    expect(r1).toEqual(r2);
  });

  it("report JSON round-trips losslessly and the honest field survives serialization", async () => {
    const report = await runGatewayBench({ now: frozenClock() });
    const roundTripped = JSON.parse(JSON.stringify(report)) as GatewayBenchReport;
    expect(roundTripped).toEqual(report);
    expect(roundTripped.honest).toEqual({ engineMode: "mock", transports: "fake" });
  });

  it("defaults `now` to the real wall clock and still produces a valid, non-negative duration", async () => {
    const report = await runGatewayBench();
    expect(typeof report.durationMs).toBe("number");
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(report.durationMs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// formatGatewayBenchReport
// ---------------------------------------------------------------------------

describe("formatGatewayBenchReport", () => {
  it("renders every field of a real report into readable lines a CLI can print", async () => {
    const report = await runGatewayBench({ now: frozenClock() });
    const lines = formatGatewayBenchReport(report);

    expect(lines.length).toBeGreaterThan(5);
    expect(lines.some((l) => l.includes("mock"))).toBe(true);
    expect(lines.some((l) => l.includes("fake"))).toBe(true);
    expect(lines.some((l) => l.includes("Turns executed: 2"))).toBe(true);
    expect(lines.some((l) => l.includes("Cross-platform continuity: yes"))).toBe(true);
    expect(lines.some((l) => l.includes("Switched-channel prefix flagged: yes"))).toBe(true);
    expect(lines.some((l) => l.toLowerCase().includes("unverified=5"))).toBe(true);
  });

  it("degrades gracefully on an empty/zeroed report instead of throwing", () => {
    const empty: GatewayBenchReport = {
      platforms: [],
      turns: 0,
      pairedHandles: 0,
      identities: 0,
      sessionIds: [],
      crossPlatformContinuity: false,
      switchedChannelFlagged: false,
      badges: {},
      durationMs: 0,
      honest: { engineMode: "mock", transports: "fake" },
    };
    const lines = formatGatewayBenchReport(empty);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("undefined");
  });
});

// ---------------------------------------------------------------------------
// Sabotage runs — proving the measurement methodology itself is honest, not
// merely that the happy path looks right. These reconstruct short scripts
// with the exact same building blocks runGatewayBench uses (PairingGuard,
// ContinuityRouter, AgentGatewayHandler, BadgeStamper) but deliberately skip
// a step, and check that the SAME measurement approach — counting real
// session ids and real trust records, never assuming them — reports the
// sabotage rather than papering over it.
// ---------------------------------------------------------------------------

function inbound(platform: string, user: string, text: string): InboundMessage {
  return { platform: platform as InboundMessage["platform"], user, text };
}

function buildStack() {
  const identities = new InMemoryIdentityStore();
  const trust = new InMemoryTrustStore();
  let linkCodeSeq = 0;
  const linker = new IdentityLinker(identities, { generateCode: () => `LINK-${++linkCodeSeq}`, now: () => 0 });
  let pairCodeSeq = 0;
  const guard = new PairingGuard({
    trust,
    identities,
    linker,
    now: () => 0,
    // RE_PAIR only accepts [A-Za-z0-9]{4,12} — no separators.
    generateCode: () => `PAIR${++pairCodeSeq}`,
  });

  let turnsRun = 0;
  const turnSessionIds: string[] = [];
  const turnPlatforms: string[] = [];
  const baseEngine = echoEngine();
  const countingEngine = {
    mode: baseEngine.mode,
    async respond(turn: Parameters<typeof baseEngine.respond>[0]) {
      turnsRun += 1;
      turnSessionIds.push(turn.sessionId);
      turnPlatforms.push(turn.platform);
      return baseEngine.respond(turn);
    },
  };
  const agentHandler = new AgentGatewayHandler({ engine: countingEngine });
  let sessionSeq = 0;
  const router = new ContinuityRouter(identities, agentHandler.handle, {
    newSessionId: () => `sess-${++sessionSeq}`,
  });
  const guarded = guard.wrap(router.handle);
  const badgeStamper = new BadgeStamper();
  const top = badgeStamper.wrap(
    (msg: InboundMessage) => guarded(msg) as Promise<OutboundReply & { evidence?: BadgeEvidence }>,
  );

  return {
    identities,
    trust,
    guard,
    top,
    turnCounts: () => ({
      turns: turnsRun,
      distinctSessionIds: [...new Set(turnSessionIds)],
      distinctPlatforms: [...new Set(turnPlatforms)],
    }),
  };
}

describe("sabotage: the bench measures, it does not assume", () => {
  it("skipping /link (pairing email as an INDEPENDENT identity instead of linking it) yields crossPlatformContinuity=false with 2 identities", async () => {
    const stack = buildStack();

    const { code: tgCode } = stack.guard.issuePairingCode();
    await stack.top(inbound("telegram", "tg-1", `/pair ${tgCode}`));
    await stack.top(inbound("telegram", "tg-1", "hello from telegram"));

    // Sabotage: pair email with its OWN fresh code instead of /link-ing it to
    // the telegram identity — same human in the story, but never proven so.
    const { code: emailCode } = stack.guard.issuePairingCode();
    await stack.top(inbound("email", "alice@example.test", `/pair ${emailCode}`));
    await stack.top(inbound("email", "alice@example.test", "hello from email"));

    const { turns, distinctSessionIds, distinctPlatforms } = stack.turnCounts();
    const crossPlatformContinuity = distinctPlatforms.length >= 2 && distinctSessionIds.length === 1;

    expect(turns).toBe(2);
    expect(stack.identities.size()).toBe(2); // never merged
    expect(distinctSessionIds).toHaveLength(2); // two separate conversations
    expect(crossPlatformContinuity).toBe(false); // measured false, not assumed
  });

  it("skipping pairing entirely yields turns blocked by the guard — measured as zero agent turns, not assumed", async () => {
    const stack = buildStack();

    // No /pair at all: go straight to plain text on two platforms.
    const r1 = await stack.top(inbound("telegram", "tg-2", "hello, are you there"));
    const r2 = await stack.top(inbound("email", "bob@example.test", "hello, are you there"));

    const { turns, distinctSessionIds } = stack.turnCounts();

    expect(turns).toBe(0); // the guard never let either message reach the agent
    expect(r1.accepted).toBe(false);
    expect(r2.accepted).toBe(false);
    expect(distinctSessionIds).toHaveLength(0);
    expect(stack.identities.size()).toBe(0); // no identity was ever created for an unpaired handle
    expect(stack.trust.all()).toHaveLength(0);
  });

  it("a real /link redemption (the non-sabotaged path) does merge identities and does carry one session, confirming the sabotage tests aren't just broken plumbing", async () => {
    const stack = buildStack();

    const { code: tgCode } = stack.guard.issuePairingCode();
    await stack.top(inbound("telegram", "tg-3", `/pair ${tgCode}`));
    await stack.top(inbound("telegram", "tg-3", "hello from telegram"));

    const issueReply = await stack.top(inbound("telegram", "tg-3", "/link"));
    const m = issueReply.text.match(/Link code: (\S+)/);
    expect(m).not.toBeNull();
    const linkCode = m![1];

    await stack.top(inbound("email", "carol@example.test", `/link ${linkCode}`));
    await stack.top(inbound("email", "carol@example.test", "hello from email"));

    const { turns, distinctSessionIds, distinctPlatforms } = stack.turnCounts();
    const crossPlatformContinuity = distinctPlatforms.length >= 2 && distinctSessionIds.length === 1;

    expect(turns).toBe(2);
    expect(stack.identities.size()).toBe(1);
    expect(distinctSessionIds).toHaveLength(1);
    expect(crossPlatformContinuity).toBe(true);
  });
});
