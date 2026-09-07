import { describe, expect, it } from "vitest";
import {
  DerivationIndexRegistry,
  InMemoryIndexStore,
  USER_ACCOUNT_INDEX,
  evmPath,
  ownerId,
  solanaPath,
} from "../wallet/derivation";

describe("derivation paths", () => {
  it("uses the standard BIP-44 paths for each family", () => {
    expect(evmPath(0)).toBe("m/44'/60'/0'/0/0");
    expect(evmPath(3)).toBe("m/44'/60'/0'/0/3");
    expect(solanaPath(3)).toBe("m/44'/501'/3'/0'");
  });

  it("labels owners unambiguously across kinds", () => {
    expect(ownerId({ kind: "user", userId: "1" })).toBe("user:1");
    expect(ownerId({ kind: "agent", agentId: "1" })).toBe("agent:1");
  });
});

describe("DerivationIndexRegistry", () => {
  it("always gives the human index 0", async () => {
    const registry = new DerivationIndexRegistry(new InMemoryIndexStore());
    expect(await registry.indexFor({ kind: "user", userId: "u1" })).toBe(USER_ACCOUNT_INDEX);
  });

  it("starts agents at 1, leaving 0 to the user", async () => {
    const registry = new DerivationIndexRegistry(new InMemoryIndexStore());
    expect(await registry.indexFor({ kind: "agent", agentId: "a" })).toBe(1);
  });

  it("gives every agent a distinct index", async () => {
    const registry = new DerivationIndexRegistry(new InMemoryIndexStore());
    const indices = await Promise.all(
      ["a", "b", "c", "d"].map((id) => registry.indexFor({ kind: "agent", agentId: id })),
    );
    expect(new Set(indices).size).toBe(indices.length);
  });

  it("returns the same index for the same agent, so its address never moves", async () => {
    const registry = new DerivationIndexRegistry(new InMemoryIndexStore());
    const first = await registry.indexFor({ kind: "agent", agentId: "stable" });
    await registry.indexFor({ kind: "agent", agentId: "other" });
    expect(await registry.indexFor({ kind: "agent", agentId: "stable" })).toBe(first);
  });

  it("keeps assignments across a restart", async () => {
    const store = new InMemoryIndexStore();
    const first = new DerivationIndexRegistry(store);
    const index = await first.indexFor({ kind: "agent", agentId: "persisted" });

    const second = new DerivationIndexRegistry(store);
    expect(await second.indexFor({ kind: "agent", agentId: "persisted" })).toBe(index);
  });

  it("does not reuse an index freed by a removed agent's neighbour", async () => {
    const store = new InMemoryIndexStore();
    await store.write({ "agent:a": 1, "agent:c": 3 });
    const registry = new DerivationIndexRegistry(store);
    // 2 is genuinely unused, so it is the right next index; 1 and 3 are taken.
    expect(await registry.indexFor({ kind: "agent", agentId: "d" })).toBe(2);
  });
});
