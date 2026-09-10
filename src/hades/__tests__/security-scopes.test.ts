import { describe, it, expect } from "vitest";
import { LeastPrivilege, scopedCapabilities } from "../security/scopes";
import type { TeamPolicy } from "../security/scopes";
import { CapabilityMinter, CapabilityChecker } from "../security/tokens";

const policy: TeamPolicy = {
  team: "t1",
  allow: ["code", "test", "review"],
  perRole: { coder: ["code", "test"], reviewer: ["review"] },
  deny: ["deploy"],
};

describe("scopedCapabilities", () => {
  it("grants only the requested ∩ allowed ∩ per-role set", () => {
    // coder requests more than it may have.
    expect(scopedCapabilities(policy, "coder", ["code", "test", "review", "deploy"])).toEqual(["code", "test"]);
  });

  it("deny wins over allow", () => {
    const p: TeamPolicy = { team: "t", allow: ["*"] , deny: ["deploy"] };
    expect(scopedCapabilities(p, "any", ["code", "deploy"])).toEqual(["code"]);
  });

  it("caps a request to the team allow-list", () => {
    const p: TeamPolicy = { team: "t", allow: ["code"] };
    expect(scopedCapabilities(p, "coder", ["code", "network", "spawn"])).toEqual(["code"]);
  });

  it("wildcard team allow grants everything requested except denials", () => {
    const p: TeamPolicy = { team: "t", allow: ["*"], deny: ["dangerous"] };
    expect(scopedCapabilities(p, "r", ["a", "b", "dangerous"])).toEqual(["a", "b"]);
  });
});

describe("LeastPrivilege", () => {
  it("reports what it would grant and what it stripped", () => {
    const lp = new LeastPrivilege(policy);
    expect(lp.wouldGrant("coder", "code")).toBe(true);
    expect(lp.wouldGrant("coder", "review")).toBe(false); // not in coder's per-role
    expect(lp.strippedFor("coder", ["code", "review", "deploy"])).toEqual(["review", "deploy"]);
  });

  it("mints least-privilege tokens whose scope the checker enforces", () => {
    const lp = new LeastPrivilege(policy);
    const minter = new CapabilityMinter({ now: () => 0 });
    const checker = new CapabilityChecker({ now: () => 0 });
    const tokens = lp.mintScopedTokens(minter, [
      { agentId: "coder0", role: "coder", capabilities: ["code", "test", "deploy"] },
      { agentId: "rev0", role: "reviewer", capabilities: ["review", "code"] },
    ]);

    const coderTok = tokens.get("coder0")!;
    expect(coderTok.capabilities).toEqual(["code", "test"]); // deploy stripped
    expect(checker.authorize(coderTok, "code")).toBe(true);
    expect(checker.authorize(coderTok, "deploy")).toBe(false);

    const revTok = tokens.get("rev0")!;
    expect(revTok.capabilities).toEqual(["review"]); // code not in reviewer per-role
  });
});
