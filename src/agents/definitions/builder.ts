/**
 * AgentDefinitionBuilder — fluent API for constructing typed AgentDefinitions.
 *
 * Converts an AgentDefinition into a fully wired AgentConfig (with plugins,
 * guardrails, memory, security policy) that the core harness can run directly.
 *
 * Usage:
 *   const agent = defineAgent("researcher")
 *     .role("retrieval")
 *     .description("Searches the web and synthesizes information")
 *     .instructions("You are a research assistant...")
 *     .tools(["web_search", "browser_scrape"])
 *     .memory({ scope: "user", topK: 5 })
 *     .boundaries({
 *       blockedTools: ["shell_exec"],
 *       deferWhen: ["Defer when asked for legal advice"],
 *     })
 *     .autonomy("supervised")
 *     .constraints({ requireApproval: ["file_write"], irreversibleTools: ["db_delete"] })
 *     .escalation({ escalateTo: "supervisor", when: ["When confidence < 0.7"] })
 *     .build();
 *
 *   registerAgent("researcher", agent);
 */

import type { AgentRole, AutonomyLevel, AgentMemoryConfig, AgentBoundaries, AgentConstraints, EscalationConfig, AgentMetricsConfig, CollaborationConfig, FeedbackConfig, AgentDefinition } from "./types";
import type { AgentConfig, ModelSettings } from "../types";
import type { HarnessPlugin } from "../types";
import { withMemory } from "../plugins/memory";
import { withGuardrails } from "../plugins/guardrails";
import { withApprovals } from "../plugins/approvals";
import { withObservability } from "../plugins/observability";
import { withSecurity } from "../security/plugin";
import { createPolicy } from "../security/policy";
import { withStructuredReasoning } from "../plugins/structured-reasoning";
import { maxLengthGuardrail, blockedKeywordsGuardrail } from "../guardrails/index";

export class AgentDefinitionBuilder {
  private def: Partial<AgentDefinition> = {};
  private extraPlugins: HarnessPlugin[] = [];

  constructor(private readonly agentName: string) {
    this.def.name = agentName;
  }

  role(role: AgentRole): this { this.def.role = role; return this; }
  description(desc: string): this { this.def.description = desc; return this; }

  instructions(inst: AgentConfig["instructions"]): this {
    this.def.instructions = inst;
    return this;
  }

  model(modelId: string): this { this.def.model = modelId; return this; }
  modelSettings(s: ModelSettings): this { this.def.modelSettings = s; return this; }

  tools(toolNames: string[]): this { this.def.tools = toolNames; return this; }
  skills(skillNames: string[]): this { this.def.skills = skillNames; return this; }
  handoffs(agentNames: string[]): this { this.def.handoffs = agentNames; return this; }
  maxTurns(n: number): this { this.def.maxTurns = n; return this; }

  memory(config: AgentMemoryConfig): this { this.def.memory = config; return this; }
  boundaries(b: AgentBoundaries): this { this.def.boundaries = b; return this; }
  autonomy(level: AutonomyLevel): this { this.def.autonomy = level; return this; }
  constraints(c: AgentConstraints): this { this.def.constraints = c; return this; }
  escalation(e: EscalationConfig): this { this.def.escalation = e; return this; }
  metrics(m: AgentMetricsConfig): this { this.def.metrics = m; return this; }
  collaboration(c: CollaborationConfig): this { this.def.collaboration = c; return this; }
  feedback(f: FeedbackConfig): this { this.def.feedback = f; return this; }

  /** Add a custom plugin directly. */
  plugin(p: HarnessPlugin): this { this.extraPlugins.push(p); return this; }

  /** Add structured reasoning (PLAN→ACT→VERIFY→CRITIC LOOP) to this agent. */
  structuredReasoning(goal: string, opts: Omit<Parameters<typeof withStructuredReasoning>[0], "role" | "goal"> = {}): this {
    const role = this.def.role ?? "custom";
    this.extraPlugins.push(withStructuredReasoning({ role, goal, ...opts }));
    return this;
  }

  /**
   * Build the AgentDefinition and derive a wired AgentConfig with plugins.
   * The returned config is ready to pass to createCoreHarness() or registerAgent().
   */
  build(): AgentDefinition {
    const { def, extraPlugins } = this;
    const plugins: HarnessPlugin[] = [];

    // ── Memory ──────────────────────────────────────────────────────────────
    if (def.memory && def.memory.scope !== "none") {
      const memKey = def.memory.scope === "session" ? "threadId"
        : def.memory.scope === "global" ? "global"
        : "userId";
      plugins.push(withMemory({ key: memKey, topK: def.memory.topK ?? 5 }));
    }

    // ── Guardrails from boundaries ───────────────────────────────────────────
    const inputGuardrails = [];
    if (def.boundaries?.maxOutputLength) {
      inputGuardrails.push(maxLengthGuardrail(def.boundaries.maxOutputLength));
    }
    if (def.boundaries?.refuseTopics?.length) {
      inputGuardrails.push(blockedKeywordsGuardrail(def.boundaries.refuseTopics));
    }
    if (inputGuardrails.length > 0) {
      plugins.push(withGuardrails({ input: inputGuardrails }));
    }

    // ── Approvals from constraints ────────────────────────────────────────────
    const approvalTools = [
      ...(def.constraints?.requireApproval ?? []),
      ...(def.autonomy === "assisted" ? (def.tools ?? []) : []),
    ];
    if (approvalTools.length > 0) {
      plugins.push(withApprovals({ requireApprovalFor: approvalTools }));
    }

    // ── Security policy from boundaries ──────────────────────────────────────
    if (def.boundaries?.blockedTools?.length) {
      const policy = createPolicy({
        deny: def.boundaries.blockedTools,
        name: `${def.name}-policy`,
      });
      plugins.push(withSecurity({ policy }));
    }

    // ── Observability (always on if metrics enabled) ──────────────────────────
    if (def.metrics?.enabled) {
      plugins.push(withObservability());
    }

    // ── Extra user plugins ────────────────────────────────────────────────────
    plugins.push(...extraPlugins);

    // ── Build base instructions incorporating boundaries / escalation ─────────
    const baseInstructions = def.instructions ?? `You are ${def.name}.`;
    const enrichedInstructions = buildInstructions(
      baseInstructions,
      def.boundaries,
      def.constraints,
      def.escalation
    );

    const result: AgentDefinition = {
      name: def.name ?? this.agentName,
      role: def.role ?? "custom",
      instructions: enrichedInstructions,
      model: def.model,
      modelSettings: def.modelSettings,
      tools: def.tools,
      skills: def.skills,
      handoffs: def.constraints?.noHandoffs ? [] : (def.handoffs ?? def.collaboration?.canDelegate),
      maxTurns: def.maxTurns,
      plugins,
      boundaries: def.boundaries,
      autonomy: def.autonomy ?? "supervised",
      memory: def.memory,
      constraints: def.constraints,
      escalation: def.escalation,
      metrics: def.metrics,
      collaboration: def.collaboration,
      feedback: def.feedback,
      description: def.description,
    };

    return result;
  }
}

// ── Instruction enrichment ────────────────────────────────────────────────────

function buildInstructions(
  base: AgentConfig["instructions"],
  boundaries?: AgentBoundaries,
  constraints?: AgentConstraints,
  escalation?: EscalationConfig
): AgentConfig["instructions"] {
  const addenda: string[] = [];

  if (boundaries?.deferWhen?.length) {
    addenda.push("## Deferral rules\n" + boundaries.deferWhen.map((r) => `- ${r}`).join("\n"));
  }
  if (boundaries?.refuseTopics?.length) {
    addenda.push("## Topics you must refuse\n" + boundaries.refuseTopics.map((t) => `- ${t}`).join("\n"));
  }
  if (constraints?.irreversibleTools?.length) {
    addenda.push(
      "## Irreversible tools — always warn the user before calling:\n" +
        constraints.irreversibleTools.map((t) => `- ${t}`).join("\n")
    );
  }
  if (escalation?.when?.length) {
    addenda.push(
      `## When to escalate to ${escalation.escalateTo}:\n` +
        escalation.when.map((w) => `- ${w}`).join("\n")
    );
  }

  if (addenda.length === 0) return base;

  const suffix = "\n\n" + addenda.join("\n\n");

  if (typeof base === "string") return base + suffix;
  return async (ctx) => {
    const resolved = await Promise.resolve(base(ctx));
    return resolved + suffix;
  };
}

/**
 * Start building an AgentDefinition.
 * Call .build() to get the wired AgentDefinition (which is also a valid AgentConfig).
 */
export function defineAgent(name: string): AgentDefinitionBuilder {
  return new AgentDefinitionBuilder(name);
}
