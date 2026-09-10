/** Context a slash command runs with. */
export interface SlashContext {
  /** Raw argument string (everything after the command name). */
  argString: string;
  /** Tokenized arguments. */
  args: string[];
  write: (line: string) => void;
}

export interface SlashCommand {
  name: string;
  description: string;
  aliases?: string[];
  /** Run the command; return text to show, or void if it wrote directly. */
  run(ctx: SlashContext): string | void | Promise<string | void>;
}

export interface DispatchResult {
  handled: boolean;
  /** True when the input looked like a slash command but none matched. */
  unknown?: boolean;
  command?: string;
  output?: string;
}

/**
 * Registry of REPL slash commands (`/help`, `/model`, `/clear`…). Resolves by
 * name or alias, offers prefix autocomplete, and dispatches a `/`-prefixed line
 * to the matching command. Unknown `/`-commands are reported rather than sent to
 * the agent, so a typo doesn't become a prompt.
 */
export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();
  private aliasIndex = new Map<string, string>();

  register(command: SlashCommand): this {
    this.commands.set(command.name, command);
    for (const a of command.aliases ?? []) this.aliasIndex.set(a, command.name);
    return this;
  }

  get(name: string): SlashCommand | undefined {
    return this.commands.get(name) ?? (this.aliasIndex.has(name) ? this.commands.get(this.aliasIndex.get(name)!) : undefined);
  }

  list(): SlashCommand[] {
    return [...this.commands.values()];
  }

  /** Command names (with leading `/`) matching a prefix, for autocomplete. */
  complete(prefix: string): string[] {
    const p = prefix.startsWith("/") ? prefix.slice(1) : prefix;
    const names = [...this.commands.keys(), ...this.aliasIndex.keys()];
    return names
      .filter((n) => n.startsWith(p))
      .sort()
      .map((n) => `/${n}`);
  }

  /** Is this input a slash command line? */
  isCommand(line: string): boolean {
    return line.trimStart().startsWith("/");
  }

  /** Parse `/name arg1 arg2` into its parts. */
  parse(line: string): { name: string; argString: string; args: string[] } {
    const trimmed = line.trimStart().slice(1); // drop leading "/"
    const spaceIdx = trimmed.search(/\s/);
    const name = spaceIdx < 0 ? trimmed : trimmed.slice(0, spaceIdx);
    const argString = spaceIdx < 0 ? "" : trimmed.slice(spaceIdx + 1).trim();
    const args = argString ? argString.split(/\s+/) : [];
    return { name, argString, args };
  }

  async dispatch(line: string, write: (l: string) => void): Promise<DispatchResult> {
    if (!this.isCommand(line)) return { handled: false };
    const { name, argString, args } = this.parse(line);
    const command = this.get(name);
    if (!command) {
      write(`Unknown command: /${name}. Try /help.`);
      return { handled: true, unknown: true, command: name };
    }
    const output = await command.run({ argString, args, write });
    if (typeof output === "string" && output) write(output);
    return { handled: true, command: command.name, output: output || undefined };
  }
}

/** A `/help` command that lists every registered command. */
export function helpCommand(registry: SlashCommandRegistry): SlashCommand {
  return {
    name: "help",
    description: "List available commands",
    aliases: ["?"],
    run() {
      return registry
        .list()
        .map((c) => `/${c.name}${c.aliases?.length ? ` (${c.aliases.join(", ")})` : ""} — ${c.description}`)
        .join("\n");
    },
  };
}
