import { describe, it, expect } from "vitest";
import { CapabilityMinter, CapabilityChecker } from "../security/tokens";

describe("CapabilityMinter", () => {
  it("mints a scoped, expiring token", () => {
    const minter = new CapabilityMinter({ now: () => 1000, ttlMs: 500 });
    const tok = minter.mint({ agentId: "a1", team: "t1", capabilities: ["code", "test"] });
    expect(tok).toMatchObject({ tokenId: "tok-1", agentId: "a1", team: "t1", issuedAt: 1000, expiresAt: 1500 });
    expect(tok.capabilities).toEqual(["code", "test"]);
  });

  it("mints one token per team member from the roster", () => {
    const minter = new CapabilityMinter({ now: () => 0 });
    const tokens = minter.mintForTeam("t1", [
      { agentId: "planner0", capabilities: ["plan"] },
      { agentId: "coder0", capabilities: ["code"] },
    ]);
    expect(tokens.size).toBe(2);
    expect(tokens.get("coder0")?.capabilities).toEqual(["code"]);
  });
});

describe("CapabilityChecker", () => {
  it("authorizes only granted capabilities (deny-by-default)", () => {
    const minter = new CapabilityMinter({ now: () => 0 });
    const checker = new CapabilityChecker({ now: () => 0 });
    const tok = minter.mint({ agentId: "a", team: "t", capabilities: ["code"] });
    expect(checker.authorize(tok, "code")).toBe(true);
    expect(checker.authorize(tok, "deploy")).toBe(false);
  });

  it("honors a wildcard capability", () => {
    const minter = new CapabilityMinter({ now: () => 0 });
    const checker = new CapabilityChecker({ now: () => 0 });
    const tok = minter.mint({ agentId: "admin", team: "t", capabilities: ["*"] });
    expect(checker.authorize(tok, "anything")).toBe(true);
  });

  it("rejects an expired token", () => {
    let t = 0;
    const minter = new CapabilityMinter({ now: () => t, ttlMs: 100 });
    const checker = new CapabilityChecker({ now: () => t });
    const tok = minter.mint({ agentId: "a", team: "t", capabilities: ["code"] });
    expect(checker.isValid(tok)).toBe(true);
    t = 200;
    expect(checker.isValid(tok)).toBe(false);
    expect(checker.authorize(tok, "code")).toBe(false);
  });

  it("assert throws for unauthorized or expired", () => {
    const minter = new CapabilityMinter({ now: () => 0 });
    const checker = new CapabilityChecker({ now: () => 0 });
    const tok = minter.mint({ agentId: "a", team: "t", capabilities: ["code"] });
    expect(() => checker.assert(tok, "code")).not.toThrow();
    expect(() => checker.assert(tok, "deploy")).toThrow(/not authorized for capability: deploy/);
  });
});
