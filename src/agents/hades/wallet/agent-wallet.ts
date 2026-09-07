import {
  WALLET_ERROR,
  type AccountOwner,
  type ChainFamily,
  type SpendPolicy,
} from "../protocol";
import {
  DerivationIndexRegistry,
  InMemoryIndexStore,
  evmPath,
  ownerId,
  solanaPath,
  type IndexAssignmentStore,
} from "./derivation";
import { SpendLedger, type SpendLedgerStore } from "./spend-ledger";

/**
 * Wallets for the people and the agents in a Hades workspace.
 *
 * The crypto libraries are optional dependencies, loaded on first use the same
 * way the harness loads Tavily or Playwright — an installation that never
 * touches a wallet should not have to carry ethers and web3.js.
 */

export interface ChainConfig {
  caip2: string;
  family: ChainFamily;
  name: string;
  chainId?: number;
  rpcUrl: string;
  nativeSymbol: string;
  nativeDecimals: number;
}

export const DEFAULT_CHAINS: ChainConfig[] = [
  {
    caip2: "eip155:1",
    family: "evm",
    name: "Ethereum",
    chainId: 1,
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
  },
  {
    caip2: "eip155:8453",
    family: "evm",
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://base-rpc.publicnode.com",
    nativeSymbol: "ETH",
    nativeDecimals: 18,
  },
  {
    caip2: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    family: "solana",
    name: "Solana",
    rpcUrl: "https://api.mainnet-beta.solana.com",
    nativeSymbol: "SOL",
    nativeDecimals: 9,
  },
];

export interface WalletAddresses {
  evm: string;
  solana: string;
  derivationIndex: number;
}

/** Fiat pricing, injected so the wallet has no opinion about where it comes from. */
export interface PriceOracle {
  nativeUsd(caip2: string): Promise<number | null>;
}

export interface ApprovalHook {
  (request: {
    owner: AccountOwner;
    summary: string;
    detail?: string;
    caip2: string;
    usdValue: number;
  }): Promise<boolean>;
}

export class WalletPolicyError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "WalletPolicyError";
  }
}

export interface HadesWalletRegistryOptions {
  /** BIP-39 phrase backing every derived account. */
  mnemonic: string;
  chains?: ChainConfig[];
  indexStore?: IndexAssignmentStore;
  spendStore?: SpendLedgerStore;
  priceOracle?: PriceOracle;
  /**
   * Called when the policy allows a transaction but still wants a human.
   * Wire this to the harness's escalation module; the default refuses, so an
   * unconfigured deployment cannot spend money unattended.
   */
  onApprovalRequired?: ApprovalHook;
}

export class HadesWalletRegistry {
  readonly ledger: SpendLedger;
  readonly #mnemonic: string;
  readonly #chains: Map<string, ChainConfig>;
  readonly #indices: DerivationIndexRegistry;
  readonly #priceOracle: PriceOracle | undefined;
  readonly #onApprovalRequired: ApprovalHook;
  readonly #wallets = new Map<string, HadesAgentWallet>();

  constructor(options: HadesWalletRegistryOptions) {
    this.#mnemonic = options.mnemonic;
    this.#chains = new Map((options.chains ?? DEFAULT_CHAINS).map((chain) => [chain.caip2, chain]));
    this.#indices = new DerivationIndexRegistry(options.indexStore ?? new InMemoryIndexStore());
    this.ledger = new SpendLedger(options.spendStore);
    this.#priceOracle = options.priceOracle;
    this.#onApprovalRequired = options.onApprovalRequired ?? (async () => false);
  }

  /**
   * Build a registry from the environment. Refuses rather than silently
   * generating a throwaway phrase: a wallet whose seed vanishes on restart
   * loses whatever was sent to it.
   */
  static fromEnv(overrides: Partial<HadesWalletRegistryOptions> = {}): HadesWalletRegistry {
    const mnemonic = overrides.mnemonic ?? process.env.HADES_WALLET_MNEMONIC;
    if (!mnemonic) {
      throw new Error(
        "HADES_WALLET_MNEMONIC is not set. Generate a BIP-39 phrase, store it in your secret manager, and set it before using agent wallets.",
      );
    }
    return new HadesWalletRegistry({ ...overrides, mnemonic });
  }

  chains(): ChainConfig[] {
    return [...this.#chains.values()];
  }

  chain(caip2: string): ChainConfig | undefined {
    return this.#chains.get(caip2);
  }

  /** The wallet for one owner, created on first request and cached after. */
  async walletFor(owner: AccountOwner): Promise<HadesAgentWallet> {
    const key = ownerId(owner);
    const cached = this.#wallets.get(key);
    if (cached) return cached;

    const index = await this.#indices.indexFor(owner);
    const wallet = new HadesAgentWallet({
      owner,
      derivationIndex: index,
      mnemonic: this.#mnemonic,
      chains: this.#chains,
      ledger: this.ledger,
      priceOracle: this.#priceOracle,
      onApprovalRequired: this.#onApprovalRequired,
    });
    this.#wallets.set(key, wallet);
    return wallet;
  }

  async setPolicy(owner: AccountOwner, policy: Omit<SpendPolicy, "ownerId">): Promise<void> {
    await this.ledger.setPolicy({ ...policy, ownerId: ownerId(owner) });
  }

  async assignments(): Promise<Record<string, number>> {
    return this.#indices.assignments();
  }
}

interface WalletDeps {
  owner: AccountOwner;
  derivationIndex: number;
  mnemonic: string;
  chains: Map<string, ChainConfig>;
  ledger: SpendLedger;
  priceOracle: PriceOracle | undefined;
  onApprovalRequired: ApprovalHook;
}

export class HadesAgentWallet {
  readonly owner: AccountOwner;
  readonly derivationIndex: number;
  readonly #deps: WalletDeps;
  #addresses: WalletAddresses | null = null;

  constructor(deps: WalletDeps) {
    this.#deps = deps;
    this.owner = deps.owner;
    this.derivationIndex = deps.derivationIndex;
  }

  get ownerId(): string {
    return ownerId(this.owner);
  }

  async addresses(): Promise<WalletAddresses> {
    if (this.#addresses) return this.#addresses;
    const [evm, solana] = await Promise.all([this.#evmWallet(), this.#solanaKeypair()]);
    this.#addresses = {
      evm: evm.address,
      solana: solana.publicKey.toBase58(),
      derivationIndex: this.derivationIndex,
    };
    return this.#addresses;
  }

  async balance(caip2: string): Promise<{ raw: string; formatted: string; symbol: string }> {
    const chain = this.#requireChain(caip2);
    const addresses = await this.addresses();
    if (chain.family === "evm") {
      const { JsonRpcProvider, formatUnits } = await import("ethers");
      const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
      try {
        const raw = await provider.getBalance(addresses.evm);
        return {
          raw: raw.toString(),
          formatted: formatUnits(raw, chain.nativeDecimals),
          symbol: chain.nativeSymbol,
        };
      } finally {
        provider.destroy();
      }
    }
    const { Connection, PublicKey } = await import("@solana/web3.js");
    const connection = new Connection(chain.rpcUrl, "confirmed");
    const lamports = await connection.getBalance(new PublicKey(addresses.solana));
    return {
      raw: String(lamports),
      formatted: (lamports / 10 ** chain.nativeDecimals).toString(),
      symbol: chain.nativeSymbol,
    };
  }

  /** Sign an arbitrary message. No value moves, so no policy check applies. */
  async signMessage(message: string, family: ChainFamily = "evm"): Promise<string> {
    if (family === "evm") {
      const wallet = await this.#evmWallet();
      return wallet.signMessage(message);
    }
    const [{ default: bs58 }, keypair] = await Promise.all([
      import("bs58"),
      this.#solanaKeypair(),
    ]);
    const { ed25519 } = await import("@noble/curves/ed25519.js");
    const signature = ed25519.sign(new TextEncoder().encode(message), keypair.secretKey.slice(0, 32));
    return bs58.encode(signature);
  }

  /**
   * Send native currency. The policy gate runs before anything is signed, and
   * a transaction the policy refuses never reaches a human for approval —
   * that is the difference between a budget and a suggestion.
   */
  async send(input: {
    caip2: string;
    to: string;
    /** Decimal amount in the chain's native units, e.g. "0.05". */
    amount: string;
    memo?: string;
  }): Promise<{ txHash: string; usdValue: number }> {
    const chain = this.#requireChain(input.caip2);
    const usdValue = await this.#usdValue(chain, input.amount);

    const verdict = await this.#deps.ledger.evaluate(this.ownerId, {
      usdValue,
      caip2: chain.caip2,
      target: input.to,
    });
    if (!verdict.allowed) {
      throw new WalletPolicyError(verdict.code, verdict.reason);
    }

    if (verdict.requiresApproval) {
      const approved = await this.#deps.onApprovalRequired({
        owner: this.owner,
        summary: `Send ${input.amount} ${chain.nativeSymbol} to ${input.to}`,
        detail: input.memo,
        caip2: chain.caip2,
        usdValue,
      });
      if (!approved) {
        throw new WalletPolicyError(WALLET_ERROR.userRejected, "The transaction was not approved.");
      }
    }

    const txHash =
      chain.family === "evm"
        ? await this.#sendEvm(chain, input.to, input.amount)
        : await this.#sendSolana(chain, input.to, input.amount);

    await this.#deps.ledger.record({
      ownerId: this.ownerId,
      at: Date.now(),
      usdValue,
      caip2: chain.caip2,
      txHash,
    });
    return { txHash, usdValue };
  }

  async policy(): Promise<SpendPolicy> {
    return this.#deps.ledger.policyFor(this.ownerId);
  }

  async spentToday(): Promise<number> {
    return this.#deps.ledger.spentToday(this.ownerId);
  }

  async #sendEvm(chain: ChainConfig, to: string, amount: string): Promise<string> {
    const { JsonRpcProvider, parseUnits } = await import("ethers");
    const provider = new JsonRpcProvider(chain.rpcUrl, chain.chainId, { staticNetwork: true });
    try {
      const wallet = (await this.#evmWallet()).connect(provider);
      const response = await wallet.sendTransaction({
        to,
        value: parseUnits(amount, chain.nativeDecimals),
      });
      return response.hash;
    } finally {
      provider.destroy();
    }
  }

  async #sendSolana(chain: ChainConfig, to: string, amount: string): Promise<string> {
    const { Connection, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } =
      await import("@solana/web3.js");
    const keypair = await this.#solanaKeypair();
    const connection = new Connection(chain.rpcUrl, "confirmed");
    const lamports = BigInt(Math.round(Number(amount) * 10 ** chain.nativeDecimals));
    const transaction = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: keypair.publicKey,
        toPubkey: new PublicKey(to),
        lamports,
      }),
    );
    return sendAndConfirmTransaction(connection, transaction, [keypair]);
  }

  async #evmWallet() {
    const { HDNodeWallet, Mnemonic } = await import("ethers");
    return HDNodeWallet.fromMnemonic(
      Mnemonic.fromPhrase(this.#deps.mnemonic),
      evmPath(this.derivationIndex),
    );
  }

  async #solanaKeypair() {
    const [{ Keypair }, { mnemonicToSeedSync }, { derivePath }] = await Promise.all([
      import("@solana/web3.js"),
      import("bip39"),
      import("ed25519-hd-key"),
    ]);
    const seed = mnemonicToSeedSync(this.#deps.mnemonic);
    const { key } = derivePath(solanaPath(this.derivationIndex), seed.toString("hex"));
    return Keypair.fromSeed(key);
  }

  /**
   * An unpriceable transaction counts as infinite value, so a missing price
   * feed makes the policy stricter rather than waving a transfer through.
   */
  async #usdValue(chain: ChainConfig, amount: string): Promise<number> {
    const price = await this.#deps.priceOracle?.nativeUsd(chain.caip2);
    if (price === null || price === undefined) return Number.POSITIVE_INFINITY;
    return Number(amount) * price;
  }

  #requireChain(caip2: string): ChainConfig {
    const chain = this.#deps.chains.get(caip2);
    if (!chain) {
      throw new WalletPolicyError(WALLET_ERROR.unsupportedMethod, `Unknown chain ${caip2}.`);
    }
    return chain;
  }
}
