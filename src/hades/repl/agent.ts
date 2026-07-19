import { randomUUID } from "node:crypto";
import type { MemoryStore, MemorySearchResult } from "../memory/store";
import type { SessionStore, SessionMessage } from "../memory/session-store";
import { loadContextFiles, assembleContextPrompt } from "../memory/context-files";
import type { UserModel } from "../learning/user-model";
import type { ModelCommand } from "../models/command";
import { Repl } from "./core";
import type { ReplHandler, ReplIO, ReplOptions } from "./core";
import { SlashCommandRegistry, helpCommand } from "./commands";

/** What the "brain" (LLM / swarm) receives for one conversational turn. */
export interface ConversationTurnContext {
  input: string;
  /** Memories relevant to this input, best-first. */
  memories: MemorySearchResult[];
  /** A prose description of the user model, if one is built. */
  userProfile?: string;
  /** Recent conversation messages for continuity. */
  history: SessionMessage[];
  /** Injection-fenced MEMORY.md/USER.md context (see ../memory/context-files),
   *  when context files are configured and at least one exists. */
  contextPrompt?: string;
}

/**
 * The agent's response engine: given the memory-augmented context, stream a
 * reply and resolve with the final text. Injectable so tests use a fake brain
 * and production wires the swarm/LLM behind it.
 */
export type ConversationBrain = (
  ctx: ConversationTurnContext,
  stream: (chunk: string) => void,
  signal: AbortSignal
) => Promise<string>;

export interface ConversationalAgentDeps {
  brain: ConversationBrain;
  memory?: MemoryStore;
  sessions?: SessionStore;
  userModel?: UserModel;
  /** For the `/model` command. */
  models?: ModelCommand;
  /** How many memories to inject per turn. Default 5. */
  memoryLimit?: number;
  /** How many recent messages to pass as history. Default 10. */
  historyLimit?: number;
  /** Load MEMORY.md/USER.md context files each turn (project dir wins over
   *  data dir per file). Re-read every turn so on-disk edits — including
   *  appendMemoryFact write-backs — are picked up immediately. */
  contextFiles?: { dataDir: string; projectDir?: string; maxChars?: number };
  now?: () => number;
}

/**
 * The closed conversational loop — Phase E's payoff. Each turn: retrieve
 * memories relevant to the input (plus the user model), hand them to the brain,
 * stream the reply, and persist both sides to the session store so the next turn
 * has continuity. Slash commands (`/remember`, `/recall`, `/model`, `/history`,
 * `/help`) let the user drive memory and model directly. Everything is
 * injectable, so the whole loop runs in tests without an LLM, a swarm, or a disk.
 */
export class ConversationalAgent {
  readonly sessionId: string;
  readonly commands: SlashCommandRegistry;
  private readonly memoryLimit: number;
  private readonly historyLimit: number;

  constructor(private readonly deps: ConversationalAgentDeps) {
    this.memoryLimit = deps.memoryLimit ?? 5;
    this.historyLimit = deps.historyLimit ?? 10;
    this.sessionId = deps.sessions?.create({ title: "REPL session" }).id ?? randomUUID();
    this.commands = this.buildCommands();
  }

  /** The REPL handler: memory-augmented, streaming, session-persisting. */
  readonly handler: ReplHandler = async (input, stream, signal) => {
    const memories = this.deps.memory?.search(input, { limit: this.memoryLimit }) ?? [];
    const userProfile = this.deps.userModel?.describe();
    const session = this.deps.sessions?.get(this.sessionId);
    const history = (session?.messages ?? []).slice(-this.historyLimit);
    const contextPrompt = this.loadContextPrompt();

    this.deps.sessions?.append(this.sessionId, { role: "user", content: input });
    const reply = await this.deps.brain({ input, memories, userProfile, history, contextPrompt }, stream, signal);
    if (reply) this.deps.sessions?.append(this.sessionId, { role: "assistant", content: reply });
    return reply;
  };

  /** Build a REPL wired to this agent. */
  repl(io: ReplIO, opts: Omit<ReplOptions, "commands"> = {}): Repl {
    return new Repl(io, this.handler, { ...opts, commands: this.commands });
  }

  /** Fresh-per-turn MEMORY.md/USER.md context (real fs reads through
   *  ../memory/context-files — capped, injection-fenced, precedence-resolved).
   *  Returns undefined when unconfigured or when neither file exists. */
  private loadContextPrompt(): string | undefined {
    const cf = this.deps.contextFiles;
    if (!cf) return undefined;
    const files = loadContextFiles({ dataDir: cf.dataDir, projectDir: cf.projectDir });
    if (files.length === 0) return undefined;
    const assembled = assembleContextPrompt(files, { maxChars: cf.maxChars });
    return assembled.text.trim() ? assembled.text : undefined;
  }

  private buildCommands(): SlashCommandRegistry {
    const reg = new SlashCommandRegistry();
    reg.register(helpCommand(reg));

    reg.register({
      name: "remember",
      description: "Persist a fact to long-term memory",
      run: (ctx) => {
        if (!this.deps.memory) return "Memory is not configured.";
        if (!ctx.argString) return "Usage: /remember <fact>";
        // When the store is the STYX GuardedMemoryStore, use its gate-aware
        // add so a quarantined (contradicting) fact is reported honestly
        // instead of claiming "Remembered" for a write that never landed.
        const store = this.deps.memory as MemoryStore & {
          addChecked?: (input: { fact: string; source?: string; salience?: number }) => {
            verdict: { passed: boolean; reasons: string[] };
            flagged?: { id: string };
          };
        };
        if (typeof store.addChecked === "function") {
          const { verdict, flagged } = store.addChecked({ fact: ctx.argString, source: "user", salience: 0.8 });
          if (!verdict.passed) {
            const why = verdict.reasons.join(", ") || "contradiction";
            const how = flagged ? ` Resolve with \`hades memory flags resolve ${flagged.id} <accept-new|keep-existing|supersede>\`.` : "";
            return `Quarantined (contradicts existing memory: ${why}) — not written.${how}`;
          }
          return `Remembered: ${ctx.argString}`;
        }
        store.add({ fact: ctx.argString, source: "user", salience: 0.8 });
        return `Remembered: ${ctx.argString}`;
      },
    });

    reg.register({
      name: "recall",
      description: "Search long-term memory",
      aliases: ["memory"],
      run: (ctx) => {
        if (!this.deps.memory) return "Memory is not configured.";
        const hits = this.deps.memory.search(ctx.argString || "", { limit: this.memoryLimit });
        if (!hits.length) return "No matching memories.";
        return hits.map((h) => `• ${h.fact}`).join("\n");
      },
    });

    reg.register({
      name: "history",
      description: "Show the current conversation",
      run: () => {
        const session = this.deps.sessions?.get(this.sessionId);
        const msgs = session?.messages ?? [];
        if (!msgs.length) return "No conversation yet.";
        return msgs.map((m) => `${m.role}: ${m.content}`).join("\n");
      },
    });

    if (this.deps.models) {
      const models = this.deps.models;
      reg.register({
        name: "model",
        description: "Show or switch the active model",
        run: (ctx) => models.run(ctx.args).lines.join("\n"),
      });
    }

    return reg;
  }
}
