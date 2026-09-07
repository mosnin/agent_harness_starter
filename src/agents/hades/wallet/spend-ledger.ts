import {
  DEFAULT_AGENT_SPEND_POLICY,
  evaluateSpendPolicy,
  type PolicyVerdict,
  type SpendPolicy,
  type SpendRecord,
} from "../protocol";

export interface SpendLedgerStore {
  read(): Promise<{ records: SpendRecord[]; policies: Record<string, SpendPolicy> }>;
  write(state: { records: SpendRecord[]; policies: Record<string, SpendPolicy> }): Promise<void>;
}

export class InMemorySpendLedgerStore implements SpendLedgerStore {
  #state = { records: [] as SpendRecord[], policies: {} as Record<string, SpendPolicy> };

  async read() {
    return this.#state;
  }

  async write(state: { records: SpendRecord[]; policies: Record<string, SpendPolicy> }) {
    this.#state = state;
  }
}

/**
 * Per-owner budgets and the spend recorded against them. This is the only
 * thing standing between "an agent can transact" and "an agent can empty an
 * account", so it is enforced before signing rather than checked afterwards.
 */
export class SpendLedger {
  readonly #store: SpendLedgerStore;
  #records: SpendRecord[] = [];
  #policies = new Map<string, SpendPolicy>();
  #loaded = false;

  constructor(store: SpendLedgerStore = new InMemorySpendLedgerStore()) {
    this.#store = store;
  }

  async load(): Promise<void> {
    if (this.#loaded) return;
    const state = await this.#store.read();
    this.#records = state.records;
    this.#policies = new Map(Object.entries(state.policies));
    this.#loaded = true;
  }

  async policyFor(ownerId: string): Promise<SpendPolicy> {
    await this.load();
    return this.#policies.get(ownerId) ?? { ownerId, ...DEFAULT_AGENT_SPEND_POLICY };
  }

  async setPolicy(policy: SpendPolicy): Promise<void> {
    await this.load();
    this.#policies.set(policy.ownerId, policy);
    await this.#persist();
  }

  async evaluate(
    ownerId: string,
    request: { usdValue: number; caip2: string; target?: string },
  ): Promise<PolicyVerdict> {
    await this.load();
    return evaluateSpendPolicy(await this.policyFor(ownerId), request, this.#records);
  }

  /** Record only once a transaction has actually broadcast. */
  async record(record: SpendRecord): Promise<void> {
    await this.load();
    this.#records = [...this.#records, record];
    await this.#persist();
  }

  async spentToday(ownerId: string, now: number = Date.now()): Promise<number> {
    await this.load();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    return this.#records
      .filter((record) => record.ownerId === ownerId && record.at >= dayAgo)
      .reduce((total, record) => total + record.usdValue, 0);
  }

  async history(ownerId?: string): Promise<SpendRecord[]> {
    await this.load();
    return ownerId ? this.#records.filter((record) => record.ownerId === ownerId) : [...this.#records];
  }

  async #persist(): Promise<void> {
    // Thirty days: enough for a spending view, bounded enough to stay small.
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.#records = this.#records.filter((record) => record.at >= cutoff);
    await this.#store.write({
      records: this.#records,
      policies: Object.fromEntries(this.#policies),
    });
  }
}
