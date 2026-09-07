/**
 * @module @/agents/hades
 *
 * The Hades integration: per-agent crypto wallets, and a bridge into the
 * user's own Hades Browser.
 *
 * ```ts
 * import {
 *   HadesWalletRegistry,
 *   setHadesWalletRegistry,
 *   HadesBrowserClient,
 *   setHadesBrowserClient,
 * } from "@/agents/hades";
 *
 * setHadesWalletRegistry(HadesWalletRegistry.fromEnv({
 *   onApprovalRequired: async (request) => escalateToHuman(request),
 * }));
 *
 * const browser = new HadesBrowserClient({
 *   token: process.env.HADES_BROWSER_TOKEN!,
 *   agents: [{ id: "researcher", name: "Researcher", allowedTools: [] }],
 * });
 * await browser.connect();
 * setHadesBrowserClient(browser);
 * ```
 *
 * Then give an agent the tool names from HADES_WALLET_TOOL_NAMES and
 * HADES_BROWSER_TOOL_NAMES, and pass `meta: { agentId }` in the tool context —
 * that is what decides whose wallet and whose consent apply.
 */

export * from "./protocol";

export {
  HadesWalletRegistry,
  HadesAgentWallet,
  WalletPolicyError,
  DEFAULT_CHAINS,
} from "./wallet/agent-wallet";
export type {
  ApprovalHook,
  ChainConfig,
  HadesWalletRegistryOptions,
  PriceOracle,
  WalletAddresses,
} from "./wallet/agent-wallet";

export {
  DerivationIndexRegistry,
  InMemoryIndexStore,
  USER_ACCOUNT_INDEX,
  agentFingerprint,
  evmPath,
  ownerId,
  solanaPath,
} from "./wallet/derivation";
export type { IndexAssignmentStore } from "./wallet/derivation";

export { SpendLedger, InMemorySpendLedgerStore } from "./wallet/spend-ledger";
export type { SpendLedgerStore } from "./wallet/spend-ledger";

export {
  setHadesWalletRegistry,
  getHadesWalletRegistry,
  HADES_WALLET_TOOL_NAMES,
} from "./wallet/tools";

export { HadesBrowserClient, BrowserToolError } from "./browser/client";
export type { BrowserConnection, HadesBrowserClientOptions } from "./browser/client";

export {
  setHadesBrowserClient,
  getHadesBrowserClient,
  HADES_BROWSER_TOOL_NAMES,
} from "./browser/tools";
