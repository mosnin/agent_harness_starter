/**
 * T3-agreement — cross-model agreement, and the honesty rule that comes with
 * a CONDITIONAL verifier.
 *
 * Two things are pinned here. The first is the verifier's own logic:
 * unanimity passes, a split blocks, and a judge that fails to answer is
 * dropped rather than counted as a yes (an outage must never certify).
 *
 * The second matters more. Registering a verifier that needs provider keys
 * would, under the old raw-count rule, have flipped `hades trust doctor` from
 * "message cannot certify" to a PASS — while nothing had actually changed for
 * a user with no keys. The doctor must instead count EFFECTIVE voters and say
 * what is missing. That is the difference between fixing a domain and
 * relabelling it.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  crossModelAgreementVerifier,
  AGREEMENT_VERIFIER_ID,
  AGREEMENT_VERIFIER_PRIOR,
  type AgreementJudge,
} from "../agreement-verifier";
import { openTrustStack, domainCertifiability } from "../wiring";
import type { TrustSubject } from "../registry";

function subject(output = "the deploy finished at 4pm"): TrustSubject {
  return {
    domain: "message",
    subjectId: "m",
    taskId: "t",
    input: "Tell the user when the deploy finished.",
    output,
    evidence: {},
    trace: [],
  };
}

/** A judge with a fixed opinion; `undefined` models a judge that did not answer. */
function judge(family: string, answer: boolean | undefined): AgreementJudge {
  return { family, judge: async () => answer };
}

/** A judge whose call throws — an outage, not an opinion. */
function brokenJudge(family: string): AgreementJudge {
  return {
    family,
    judge: async () => {
      throw new Error("provider 503");
    },
  };
}

const tempDir = (): string => mkdtempSync(join(tmpdir(), "hades-agreement-"));
const noEnv = {} as NodeJS.ProcessEnv;

describe("agreement logic", () => {
  it("passes when independent judges are unanimous", async () => {
    const v = crossModelAgreementVerifier({ judges: [judge("anthropic", true), judge("openai", true)] });
    const verdict = await v.verify(subject());
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(true);
    expect(verdict.tier).toBe("T3-agreement");
    expect(verdict.confidence).toBeLessThanOrEqual(AGREEMENT_VERIFIER_PRIOR);
    expect(verdict.reasons.join(" ")).toContain("agreement:2/2");
  });

  it("blocks on a split vote — a second opinion that cannot block is decoration", async () => {
    const v = crossModelAgreementVerifier({ judges: [judge("anthropic", true), judge("openai", false)] });
    const verdict = await v.verify(subject());
    expect(verdict.abstained).toBe(false);
    expect(verdict.passed).toBe(false);
    expect(verdict.reasons.join(" ")).toContain("disagreement:1/2");
    expect(verdict.reasons.join(" ")).toContain("openai");
  });

  it("treats a silent judge as no vote, never as agreement", async () => {
    const v = crossModelAgreementVerifier({ judges: [judge("anthropic", true), judge("openai", undefined)] });
    const verdict = await v.verify(subject());
    // One real vote is not agreement — abstain rather than certify on it.
    expect(verdict.abstained).toBe(true);
    expect(verdict.reasons.join(" ")).toContain("silence is not agreement");
  });

  it("treats a judge outage the same way — an error is not a yes", async () => {
    const v = crossModelAgreementVerifier({ judges: [judge("anthropic", true), brokenJudge("openai")] });
    const verdict = await v.verify(subject());
    expect(verdict.abstained).toBe(true);
    expect(verdict.passed).toBe(false);
  });

  it("abstains on empty output", async () => {
    const v = crossModelAgreementVerifier({ judges: [judge("a", true), judge("b", true)] });
    expect(v.appliesTo(subject("   "))).toBe(false);
    expect((await v.verify(subject("   "))).abstained).toBe(true);
  });
});

describe("conditional registration is reported honestly", () => {
  it("declares an unmet requirement when it has too few judges", () => {
    const v = crossModelAgreementVerifier({});
    expect(v.requiresConfig?.()).toContain("ANTHROPIC_API_KEY");
    expect(v.appliesTo(subject())).toBe(false);
  });

  it("declares itself operational once judges exist", () => {
    const v = crossModelAgreementVerifier({ judges: [judge("a", true), judge("b", true)] });
    expect(v.requiresConfig?.()).toBeUndefined();
    expect(v.appliesTo(subject())).toBe(true);
  });

  it("does NOT let a keyless build claim `message` is certifiable", () => {
    const stack = openTrustStack({ dataDir: tempDir(), env: noEnv, now: () => 0 });
    const message = domainCertifiability(stack).find((c) => c.domain === "message")!;
    // Two are registered…
    expect(message.registered).toBe(2);
    // …but only one can actually vote, so the domain is still not certifiable.
    expect(message.effective).toBe(1);
    expect(message.canEverCertify).toBe(false);
    // And the operator is told exactly what to do about it.
    expect(message.detail).toContain(AGREEMENT_VERIFIER_ID);
    expect(message.detail).toContain("ANTHROPIC_API_KEY");
  });

  it("becomes genuinely certifiable when real judges are supplied", () => {
    const stack = openTrustStack({
      dataDir: tempDir(),
      env: noEnv,
      now: () => 0,
      agreementJudges: [judge("anthropic", true), judge("openai", true)],
    });
    const message = domainCertifiability(stack).find((c) => c.domain === "message")!;
    expect(message.effective).toBe(2);
    expect(message.canEverCertify).toBe(true);
  });
});
