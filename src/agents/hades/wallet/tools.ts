import { z } from "zod";
import { registerTool } from "../../tools/registry";
import type { AccountOwner } from "../protocol";
import { HadesWalletRegistry, WalletPolicyError } from "./agent-wallet";

/**
 * Wallet tools. The agent calling a tool is the owner of the wallet it acts
 * on — an agent cannot name another agent's wallet, because the owner comes
 * from the tool context rather than from the model's arguments.
 */

let registry: HadesWalletRegistry | null = null;

export function setHadesWalletRegistry(next: HadesWalletRegistry | null): void {
  registry = next;
}

export function getHadesWalletRegistry(): HadesWalletRegistry {
  if (!registry) {
    throw new Error(
      "No Hades wallet registry configured. Call setHadesWalletRegistry(HadesWalletRegistry.fromEnv()) during startup.",
    );
  }
  return registry;
}

/**
 * The owner is derived from the tool context, never from tool arguments — an
 * `agentId` parameter would let a prompt-injected agent spend someone else's
 * budget just by asking.
 */
function ownerFromContext(ctx: { userId?: string; meta?: Record<string, unknown> }): AccountOwner {
  const agentId = typeof ctx.meta?.agentId === "string" ? ctx.meta.agentId : undefined;
  if (agentId) return { kind: "agent", agentId };
  if (ctx.userId) return { kind: "user", userId: ctx.userId };
  throw new Error(
    "This tool needs either meta.agentId or userId in its context to know whose wallet to use.",
  );
}

export const walletAddressTool = registerTool({
  name: "wallet_address",
  description:
    "Get this agent's own wallet addresses. Returns an EVM address and a Solana address. Use these when you need somewhere for funds to be sent.",
  category: "wallet",
  parameters: z.object({}),
  async execute(_input, ctx) {
    const wallet = await getHadesWalletRegistry().walletFor(ownerFromContext(ctx));
    return wallet.addresses();
  },
});

export const walletBalanceTool = registerTool({
  name: "wallet_balance",
  description:
    "Read this agent's native-currency balance on one chain. Check this before proposing a transaction you cannot fund.",
  category: "wallet",
  parameters: z.object({
    caip2: z
      .string()
      .describe('CAIP-2 chain id, e.g. "eip155:1" for Ethereum or "eip155:8453" for Base'),
  }),
  async execute({ caip2 }, ctx) {
    const wallet = await getHadesWalletRegistry().walletFor(ownerFromContext(ctx));
    return wallet.balance(caip2);
  },
});

export const walletPolicyTool = registerTool({
  name: "wallet_policy",
  description:
    "Read this agent's spending limits and what it has already spent today. Check this before proposing a transaction that may be refused.",
  category: "wallet",
  parameters: z.object({}),
  async execute(_input, ctx) {
    const wallet = await getHadesWalletRegistry().walletFor(ownerFromContext(ctx));
    const [policy, spentToday] = await Promise.all([wallet.policy(), wallet.spentToday()]);
    return {
      maxPerTransactionUsd: policy.maxPerTransactionUsd,
      maxPerDayUsd: policy.maxPerDayUsd,
      spentTodayUsd: spentToday,
      requiresApprovalAlways: policy.requireApprovalAlways,
      allowedChains: policy.allowedChains,
      allowedTargets: policy.allowedTargets,
    };
  },
});

export const walletSignMessageTool = registerTool({
  name: "wallet_sign_message",
  description:
    "Sign a plain-text message with this agent's key, for proving control of an address. This moves no funds.",
  category: "wallet",
  parameters: z.object({
    message: z.string().max(4096).describe("The exact text to sign"),
    chain: z.enum(["evm", "solana"]).default("evm"),
  }),
  async execute({ message, chain }, ctx) {
    const wallet = await getHadesWalletRegistry().walletFor(ownerFromContext(ctx));
    return { signature: await wallet.signMessage(message, chain) };
  },
});

export const walletSendTool = registerTool({
  name: "wallet_send",
  description:
    "Send native currency from this agent's wallet. Subject to the agent's spend policy, which is enforced before signing; over-budget transfers are refused outright.",
  category: "wallet",
  // Belt and braces: the ledger enforces the budget, and the harness asks the
  // user before the tool is even entered.
  requiresApproval: true,
  parameters: z.object({
    caip2: z.string().describe('CAIP-2 chain id, e.g. "eip155:8453"'),
    to: z.string().describe("Recipient address"),
    amount: z
      .string()
      .regex(/^\d+(\.\d+)?$/)
      .describe('Decimal amount in native units, e.g. "0.05". Never scientific notation.'),
    memo: z.string().max(280).optional().describe("Why this payment is being made"),
  }),
  async execute({ caip2, to, amount, memo }, ctx) {
    const wallet = await getHadesWalletRegistry().walletFor(ownerFromContext(ctx));
    try {
      return await wallet.send({ caip2, to, amount, memo });
    } catch (error) {
      if (error instanceof WalletPolicyError) {
        // Hand the model the reason so it can adjust rather than blindly retry.
        return { refused: true, code: error.code, reason: error.message };
      }
      throw error;
    }
  },
});

export const HADES_WALLET_TOOL_NAMES = [
  "wallet_address",
  "wallet_balance",
  "wallet_policy",
  "wallet_sign_message",
  "wallet_send",
] as const;
