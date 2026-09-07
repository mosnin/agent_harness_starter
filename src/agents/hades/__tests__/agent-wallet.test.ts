import { describe, expect, it, vi } from "vitest";
import {
  HadesWalletRegistry,
  WalletPolicyError,
  type HadesWalletRegistryOptions,
} from "../wallet/agent-wallet";
import { InMemoryIndexStore } from "../wallet/derivation";
import { InMemorySpendLedgerStore } from "../wallet/spend-ledger";
import { WALLET_ERROR } from "../protocol";

const MNEMONIC = "test test test test test test test test test test test junk";
const FIXED_PRICE = { async nativeUsd() { return 2_000; } };

function makeRegistry(overrides: Partial<HadesWalletRegistryOptions> = {}) {
  return new HadesWalletRegistry({
    mnemonic: MNEMONIC,
    indexStore: new InMemoryIndexStore(),
    spendStore: new InMemorySpendLedgerStore(),
    priceOracle: FIXED_PRICE,
    ...overrides,
  });
}

describe("HadesWalletRegistry", () => {
  it("refuses to run without a seed rather than inventing a throwaway one", () => {
    const saved = process.env.HADES_WALLET_MNEMONIC;
    delete process.env.HADES_WALLET_MNEMONIC;
    expect(() => HadesWalletRegistry.fromEnv()).toThrow(/HADES_WALLET_MNEMONIC/);
    if (saved !== undefined) process.env.HADES_WALLET_MNEMONIC = saved;
  });

  it("gives the human the canonical index-0 address", async () => {
    const wallet = await makeRegistry().walletFor({ kind: "user", userId: "u1" });
    const addresses = await wallet.addresses();
    expect(addresses.derivationIndex).toBe(0);
    expect(addresses.evm.toLowerCase()).toBe("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  });

  it("gives every agent its own addresses, distinct from the user's", async () => {
    const registry = makeRegistry();
    const user = await (await registry.walletFor({ kind: "user", userId: "u1" })).addresses();
    const alpha = await (await registry.walletFor({ kind: "agent", agentId: "alpha" })).addresses();
    const beta = await (await registry.walletFor({ kind: "agent", agentId: "beta" })).addresses();

    const evm = [user.evm, alpha.evm, beta.evm];
    const solana = [user.solana, alpha.solana, beta.solana];
    expect(new Set(evm).size).toBe(3);
    expect(new Set(solana).size).toBe(3);
  });

  it("derives the same agent address every time, so payments keep arriving", async () => {
    const store = new InMemoryIndexStore();
    const first = await (
      await makeRegistry({ indexStore: store }).walletFor({ kind: "agent", agentId: "steady" })
    ).addresses();
    const second = await (
      await makeRegistry({ indexStore: store }).walletFor({ kind: "agent", agentId: "steady" })
    ).addresses();
    expect(second).toEqual(first);
  });

  it("returns the same wallet instance for one owner", async () => {
    const registry = makeRegistry();
    const a = await registry.walletFor({ kind: "agent", agentId: "cached" });
    const b = await registry.walletFor({ kind: "agent", agentId: "cached" });
    expect(a).toBe(b);
  });

  it("produces a recoverable EVM signature", async () => {
    const wallet = await makeRegistry().walletFor({ kind: "agent", agentId: "signer" });
    const signature = await wallet.signMessage("hello hades");
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
  });

  it("produces a base58 Solana signature", async () => {
    const wallet = await makeRegistry().walletFor({ kind: "agent", agentId: "signer" });
    const signature = await wallet.signMessage("hello hades", "solana");
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});

describe("spend policy enforcement", () => {
  it("refuses an over-budget transfer without ever asking the user", async () => {
    const onApprovalRequired = vi.fn(async () => true);
    const registry = makeRegistry({ onApprovalRequired });
    const wallet = await registry.walletFor({ kind: "agent", agentId: "spender" });

    // Default agent policy caps a transaction at $25; 1 ETH at $2,000 is over.
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "1" }),
    ).rejects.toBeInstanceOf(WalletPolicyError);
    expect(onApprovalRequired).not.toHaveBeenCalled();
  });

  it("reports the policy code so a caller can tell refusal from failure", async () => {
    const wallet = await makeRegistry().walletFor({ kind: "agent", agentId: "spender" });
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "1" }),
    ).rejects.toMatchObject({ code: WALLET_ERROR.policyDenied });
  });

  it("asks for approval when the policy allows the amount, and stops if refused", async () => {
    const onApprovalRequired = vi.fn(async () => false);
    const registry = makeRegistry({ onApprovalRequired });
    const wallet = await registry.walletFor({ kind: "agent", agentId: "asker" });

    // $2 of ETH is inside the default $25 ceiling, so this reaches the human.
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "0.001" }),
    ).rejects.toMatchObject({ code: WALLET_ERROR.userRejected });
    expect(onApprovalRequired).toHaveBeenCalledOnce();
  });

  it("refuses by default when no approval hook is configured", async () => {
    const registry = new HadesWalletRegistry({
      mnemonic: MNEMONIC,
      indexStore: new InMemoryIndexStore(),
      spendStore: new InMemorySpendLedgerStore(),
      priceOracle: FIXED_PRICE,
    });
    const wallet = await registry.walletFor({ kind: "agent", agentId: "unwired" });
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "0.001" }),
    ).rejects.toMatchObject({ code: WALLET_ERROR.userRejected });
  });

  it("treats an unpriceable transfer as unbounded rather than free", async () => {
    const onApprovalRequired = vi.fn(async () => true);
    const registry = makeRegistry({
      priceOracle: { async nativeUsd() { return null; } },
      onApprovalRequired,
    });
    const wallet = await registry.walletFor({ kind: "agent", agentId: "unpriced" });
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "0.000001" }),
    ).rejects.toBeInstanceOf(WalletPolicyError);
    expect(onApprovalRequired).not.toHaveBeenCalled();
  });

  it("rejects a chain outside the wallet's allowlist", async () => {
    const registry = makeRegistry();
    const owner = { kind: "agent", agentId: "scoped" } as const;
    await registry.setPolicy(owner, {
      maxPerTransactionUsd: 1000,
      maxPerDayUsd: 1000,
      allowedTargets: [],
      allowedChains: ["eip155:8453"],
      autoApproveBelowUsd: 0,
      requireApprovalAlways: true,
    });
    const wallet = await registry.walletFor(owner);
    await expect(
      wallet.send({ caip2: "eip155:1", to: "0x0000000000000000000000000000000000000001", amount: "0.001" }),
    ).rejects.toMatchObject({ code: WALLET_ERROR.policyDenied });
  });

  it("rejects an unknown chain", async () => {
    const wallet = await makeRegistry().walletFor({ kind: "agent", agentId: "lost" });
    await expect(
      wallet.send({ caip2: "eip155:99999", to: "0x1", amount: "1" }),
    ).rejects.toMatchObject({ code: WALLET_ERROR.unsupportedMethod });
  });
});
