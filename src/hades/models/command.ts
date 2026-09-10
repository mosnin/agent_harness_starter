import type { ModelRegistry, ModelInfo } from "./registry";
import type { InMemoryModelSelection } from "./selection";

export interface CommandResult {
  ok: boolean;
  /** Human-readable lines for the CLI/REPL to print. */
  lines: string[];
  /** The active model after the command, when applicable. */
  active?: ModelInfo;
}

/**
 * The `hades model` command surface — pure, terminal-free logic the CLI (iter
 * 35) and REPL (iter 34) both call. It resolves the active model from the
 * persisted selection (falling back to the registry default), lists the
 * catalog with the active one marked, and switches selection with validation.
 */
export class ModelCommand {
  constructor(
    private readonly registry: ModelRegistry,
    private readonly selection: InMemoryModelSelection
  ) {}

  /** The active model: persisted selection if still valid, else the default. */
  active(): ModelInfo | undefined {
    const chosen = this.selection.get();
    if (chosen) {
      const m = this.registry.get(chosen);
      if (m) return m;
    }
    return this.registry.getDefault();
  }

  /** `hades model` / `hades model list` — the catalog, active one marked. */
  list(): CommandResult {
    const active = this.active();
    const lines: string[] = [];
    for (const [provider, models] of this.registry.byProvider()) {
      lines.push(`${provider}:`);
      for (const m of models) {
        const marker = m.id === active?.id ? "* " : "  ";
        const alias = m.aliases?.length ? ` (${m.aliases.join(", ")})` : "";
        lines.push(`  ${marker}${m.id}${alias}`);
      }
    }
    if (lines.length === 0) lines.push("No models registered.");
    return { ok: true, lines, active };
  }

  /** `hades model current`. */
  current(): CommandResult {
    const active = this.active();
    return active
      ? { ok: true, lines: [`Current model: ${active.id} (${active.displayName})`], active }
      : { ok: false, lines: ["No model selected and no default registered."] };
  }

  /** `hades model use <idOrAlias>` — switch selection, validating first. */
  use(idOrAlias: string): CommandResult {
    if (!idOrAlias?.trim()) return { ok: false, lines: ["Usage: hades model use <id>"] };
    const model = this.registry.resolve(idOrAlias);
    if (!model) {
      const known = this.registry.list().map((m) => m.id).join(", ");
      return { ok: false, lines: [`Unknown model: ${idOrAlias}`, known ? `Known: ${known}` : "No models registered."] };
    }
    this.selection.set(model.id);
    return { ok: true, lines: [`Switched to ${model.id} (${model.displayName}).`], active: model };
  }

  /** Dispatch a parsed `model` subcommand. */
  run(args: string[]): CommandResult {
    const [sub, ...rest] = args;
    switch (sub) {
      case undefined:
      case "list":
        return this.list();
      case "current":
        return this.current();
      case "use":
        return this.use(rest[0] ?? "");
      default:
        // Bare `model <id>` is shorthand for `model use <id>`.
        return this.use(sub);
    }
  }
}
