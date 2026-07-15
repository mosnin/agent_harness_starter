/** A model the agent can run on. */
export interface ModelInfo {
  id: string;
  provider: string;
  displayName: string;
  contextWindow?: number;
  /** Short aliases the user can type instead of the full id. */
  aliases?: string[];
  tags?: string[];
}

/**
 * Registry of available models. Resolves by id or alias, lists grouped by
 * provider, and marks a default. Deployments seed it from config; `hades model`
 * (see {@link ModelCommand}) reads it.
 */
export class ModelRegistry {
  private models = new Map<string, ModelInfo>();
  private aliasIndex = new Map<string, string>();
  private defaultId?: string;

  register(model: ModelInfo, opts: { default?: boolean } = {}): this {
    this.models.set(model.id, model);
    for (const a of model.aliases ?? []) this.aliasIndex.set(a.toLowerCase(), model.id);
    if (opts.default || this.defaultId == null) this.defaultId = model.id;
    return this;
  }

  /** Resolve a model by exact id or (case-insensitive) alias. */
  resolve(idOrAlias: string): ModelInfo | undefined {
    if (this.models.has(idOrAlias)) return this.models.get(idOrAlias);
    const viaAlias = this.aliasIndex.get(idOrAlias.toLowerCase());
    return viaAlias ? this.models.get(viaAlias) : undefined;
  }

  has(idOrAlias: string): boolean {
    return this.resolve(idOrAlias) !== undefined;
  }

  get(id: string): ModelInfo | undefined {
    return this.models.get(id);
  }

  list(): ModelInfo[] {
    return [...this.models.values()];
  }

  byProvider(): Map<string, ModelInfo[]> {
    const grouped = new Map<string, ModelInfo[]>();
    for (const m of this.models.values()) {
      const arr = grouped.get(m.provider) ?? [];
      arr.push(m);
      grouped.set(m.provider, arr);
    }
    return grouped;
  }

  getDefault(): ModelInfo | undefined {
    return this.defaultId ? this.models.get(this.defaultId) : undefined;
  }

  size(): number {
    return this.models.size;
  }
}
