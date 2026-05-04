# Governance Playbook — Integration Guide

A practical toolkit for enforcing consistent, auditable, and ethically sound agent behavior at scale.

---

## What is Agent Governance?

Governance is the layer that sits above individual agent logic and enforces system-wide rules. It answers:
- **What can any agent do?** — overarching policies, tool restrictions, output constraints
- **When should an agent stop?** — escalation triggers for high-risk or low-confidence situations
- **What happened?** — compliance records of every decision, queryable for review and export
- **Is the agent behaving ethically?** — fairness, privacy, harm prevention, identity honesty
- **How do the rules evolve?** — adaptation proposals, human approval gates, change logs

---

## 1. Governance Policies

A `GovernancePolicy` is a named collection of `GovernanceRule` objects evaluated in order.

```typescript
import { createGovernancePolicy, evaluate } from "@/agents/governance/policy";

const policy = createGovernancePolicy({
  name: "production",
  defaultOutcome: "allowed",
  onViolation: "block",          // "block" | "escalate" | "flag" | "allow"
  rules: [
    blockTools(["rm_rf", "drop_database"]),
    blockContentPatterns("no-secrets", [/sk-[a-zA-Z0-9]{20,}/], "critical"),
    rateLimit("tool-calls", 50, "minute"),
  ],
});

// Evaluate a context against the policy
const decision = await evaluate(policy, {
  agentId: "planner",
  action: "tool:rm_rf",
  content: "rm -rf /",
});
// → { outcome: "blocked", ruleId: "block-tools:rm_rf,...", risk: "high" }
```

### Built-in rule builders

```typescript
import {
  blockTools,              // block specific tool names
  blockContentPatterns,    // block regex patterns in content
  restrictAgentTargets,    // restrict which agents can be delegated to
  rateLimit,               // flag when action count exceeds threshold
} from "@/agents/governance/policy";

// Block specific tools
blockTools(["shell_exec", "drop_database", "rm_rf"]);

// Block secrets in outputs
blockContentPatterns("no-secrets-in-output", [
  /-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----/,
  /AKIA[0-9A-Z]{16}/,       // AWS key IDs
  /sk-[a-zA-Z0-9]{20,}/,    // OpenAI-style keys
]);

// Restrict delegation targets
restrictAgentTargets(["planner", "retriever", "summarizer"]);

// Rate limiting
rateLimit("file-writes", 10, "session");
```

### Custom rules

Any function that takes a `GovernanceContext` and returns `boolean | Promise<boolean>`:

```typescript
import type { GovernanceRule } from "@/agents/governance";

const noProductionDatabaseWrites: GovernanceRule = {
  id: "no-prod-db-writes",
  description: "Agents may not write to the production database without a human-in-the-loop flag.",
  risk: "critical",
  blocking: true,
  check: async (ctx) => {
    const isProdDb = ctx.metadata?.databaseEnv === "production";
    const isWrite = ["tool:db_insert", "tool:db_update", "tool:db_delete"].includes(ctx.action);
    const humanApproved = ctx.metadata?.humanAuthorized as boolean;
    return isProdDb && isWrite && !humanApproved;
  },
};
```

---

## 2. The withGovernance Plugin

Wire governance into every agent via the plugin system:

```typescript
import { withGovernance } from "@/agents/governance/plugin";
import { DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance/policy";
import { STANDARD_ETHICS_POLICY } from "@/agents/governance/ethics";
import { compliance } from "@/agents/governance/compliance";
import { createEscalationHandler } from "@/agents/governance/escalation";

const escalation = createEscalationHandler({
  notifyHuman: async (evt) => await sendSlackAlert("#governance-alerts", evt),
  onCritical: "stop",
  onHigh: "flag",
});

const agent = createAgent({
  plugins: [
    withGovernance({
      policy: DEFAULT_GOVERNANCE_POLICY,
      ethics: STANDARD_ETHICS_POLICY,
      compliance,                    // global compliance singleton
      escalation,
      auditOnly: false,              // set true for shadow mode / dry run
      agentId: "planner",
    }),
  ],
});
```

The plugin:
- Wraps every tool call through the governance policy
- Checks every agent output through the ethics policy
- Records all decisions in the compliance tracker
- Triggers escalation for high/critical decisions
- Throws `GovernancePolicyViolationError` when `outcome === "blocked"`

---

## 3. Escalation Protocols

### When to escalate

Escalation should happen when the agent should **stop and wait** rather than continue:

| Trigger | Reason |
|---------|--------|
| High-risk tool invocation | `sensitiveToolTrigger(["shell_exec", "send_email"])` |
| Low model confidence | `lowConfidenceTrigger(0.5)` |
| Irreversible action | Covered by `requireAuthorizationForCommitments` ethics rule |
| Ethical concern | Covered by ethics policy |
| Repeated violations | `repeatedViolationTrigger(3)` |
| Manual request | Agents can request escalation explicitly |

### Creating an escalation handler

```typescript
import { createEscalationHandler } from "@/agents/governance/escalation";

const escalation = createEscalationHandler({
  // Alert a human (Slack, PagerDuty, email, etc.)
  notifyHuman: async (event) => {
    await slack.chat.postMessage({
      channel: "#agent-escalations",
      text: `[${event.reason}] ${event.description}\nAgent: ${event.agentId}`,
    });
  },

  // Optionally route to a supervisor agent
  notifyAgent: async (event) => {
    const result = await supervisorAgent.run(
      `Review and resolve this escalation:\n${JSON.stringify(event, null, 2)}`
    );
    return result.finalOutput;
  },

  onCritical: "stop",   // throw EscalationError for critical events
  onHigh: "notify",     // notify handlers but continue
});

// Trigger escalation manually from within a workflow step
await escalation.escalate(ctx, "manual_request", "Agent is unsure how to proceed.");

// Resolve a pending escalation
escalation.resolve(eventId, "Human reviewed and approved continuation.");

// View pending escalations
const pending = escalation.pending();
```

### Checking triggers before acting

```typescript
import { checkEscalationTriggers, sensitiveToolTrigger } from "@/agents/governance/escalation";

const triggers = [
  sensitiveToolTrigger(["send_email", "make_purchase"]),
  lowConfidenceTrigger(0.6),
  repeatedViolationTrigger(3),
];

const fired = await checkEscalationTriggers(triggers, ctx);
if (fired) {
  await escalation.escalate(ctx, fired.reason, fired.description);
}
```

---

## 4. Compliance Tracking

Every governance decision is automatically recorded by the compliance tracker.

```typescript
import { compliance, createComplianceTracker } from "@/agents/governance/compliance";

// Query recent violations
const violations = compliance.query({
  outcome: "blocked",
  agentId: "planner",
  since: Date.now() - 86400_000,  // last 24 hours
});

// Aggregate stats
const stats = compliance.stats({ agentId: "planner" });
// → { total: 320, byOutcome: { allowed: 300, blocked: 15, flagged: 5 }, violationRate: 0.0625 }

// Export all records (for SIEM / data warehouse ingestion)
const records = compliance.export();
await dataWarehouse.ingest("agent_compliance", records);
```

### Custom compliance sink

Forward records to an external system in real-time:

```typescript
import { createComplianceTracker } from "@/agents/governance/compliance";

const tracker = createComplianceTracker({
  maxRecords: 50_000,
  hashContent: true,    // store SHA-256 hash instead of raw content (privacy)
  sink: {
    async write(record) {
      await db.insert("compliance_records", record);
    },
  },
});
```

---

## 5. Ethical Constraints

The ethics system enforces fairness, privacy, and harm prevention on agent **outputs**.

```typescript
import {
  STANDARD_ETHICS_POLICY,
  STANDARD_ETHICS_RULES,
  createEthicsPolicy,
} from "@/agents/governance/ethics";
```

### Standard rules

| Rule ID | What it prevents |
|---------|----------------|
| `ethics:no-harmful-content` | Violence instructions, self-harm, CSAM |
| `ethics:no-identity-deception` | Claiming to be human or denying being an AI |
| `ethics:no-pii-in-output` | Email addresses, phone numbers, SSNs in outputs |
| `ethics:no-discriminatory-language` | Discriminatory language targeting protected groups |
| `ethics:require-authorization-for-commitments` | Purchases, contracts, deletions without human approval |
| `ethics:flag-fabricated-citations` | Citation-like patterns without a retrieval tool call |

### Custom ethics rules

```typescript
import { createEthicsPolicy, STANDARD_ETHICS_RULES } from "@/agents/governance/ethics";

const myEthicsPolicy = createEthicsPolicy({
  rules: [
    ...STANDARD_ETHICS_RULES,
    {
      id: "ethics:no-competitor-bashing",
      description: "Agent must not produce content that disparages competitors.",
      risk: "medium",
      blocking: false,  // flag, don't block
      check: (ctx) => {
        if (!ctx.content) return false;
        return /CompetitorName.*(is bad|terrible|avoid|worst)/i.test(ctx.content);
      },
    },
  ],
  onViolation: "block",
});
```

### Using ethics policy standalone

```typescript
const decision = await STANDARD_ETHICS_POLICY.evaluate({
  agentId: "responder",
  action: "output",
  content: agentResponse,
  metadata: { toolsUsed: false },
});

if (decision.outcome === "blocked") {
  return "I'm sorry, I can't respond to that.";
}
```

---

## 6. Governance Context

Every governance check receives a `GovernanceContext`:

```typescript
interface GovernanceContext {
  agentId: string;        // which agent is acting
  userId?: string;        // end user (for per-user limits)
  threadId?: string;      // conversation thread
  action: string;         // "tool:web_search" | "output" | "store_memory" | ...
  content?: string;       // the payload being evaluated
  metadata?: Record<string, unknown>;  // arbitrary signals for custom rules
  timestamp?: number;
}
```

Key metadata signals you can pass to enrich rule logic:

```typescript
const ctx: GovernanceContext = {
  agentId: "planner",
  action: "tool:db_update",
  metadata: {
    databaseEnv: "production",
    humanAuthorized: false,
    confidence: 0.45,
    consecutiveViolations: 2,
    actionCount: 55,         // for rate limit rules
    toolsUsed: true,         // for citation fabrication check
  },
};
```

---

## 7. Adaptation Policies

Governance must evolve — but safely. Adaptation policies control the change process.

```typescript
import { createAdaptationPolicy } from "@/agents/governance/adaptation";

const adaptation = createAdaptationPolicy({
  requireHumanApproval: true,              // all changes need a human sign-off
  allowedProposers: ["governance-agent"],  // only this agent can propose changes
  triggerReviewAfterViolationRate: 0.1,    // flag for review if 10%+ are violations
  minHoursBetweenChanges: 24,             // at most one change per day
  notifyReviewer: async (proposal) => {
    await sendEmail("security@company.com", {
      subject: `[Governance] Proposal: ${proposal.type} rule "${proposal.ruleId}"`,
      body: proposal.rationale,
    });
  },
  onApply: async (proposal) => {
    // Mutate the live rule set
    if (proposal.type === "add" && proposal.rule) {
      productionPolicy.rules.push(proposal.rule);
    } else if (proposal.type === "disable") {
      const rule = productionPolicy.rules.find((r) => r.id === proposal.ruleId);
      if (rule) rule.check = () => false;
    }
  },
});

// An agent or automated process proposes a change
await adaptation.propose(
  "add",
  "block-new-risky-tool",
  "The new `deploy_to_prod` tool has a 25% error rate and should be blocked pending review.",
  "governance-agent",
  {
    id: "block-new-risky-tool",
    description: "Block deploy_to_prod until stability is confirmed.",
    risk: "high",
    blocking: true,
    check: (ctx) => ctx.action === "tool:deploy_to_prod",
  }
);

// Human reviews and approves
await adaptation.approve(proposalId, "alice@company.com", "Confirmed — too risky for now.");

// Check if current violation rate warrants a review
const stats = compliance.stats({ since: Date.now() - 86400_000 });
if (adaptation.shouldTriggerReview(stats.violationRate)) {
  await sendAlert("Governance review triggered: violation rate " + stats.violationRate);
}

// Audit trail
const log = adaptation.log();
// → [{ id, proposal, appliedAt, appliedBy }, ...]
```

### Adaptation lifecycle

```
Propose → [Human Review] → Approve / Reject → Apply → Log
              ↑
              Triggered by: high violation rate, new tool introduction, post-incident review
```

---

## 8. Risk Levels

| Level | Meaning | Default action |
|-------|---------|---------------|
| `low` | Informational; unlikely to cause harm | Allow |
| `medium` | May cause degraded experience | Flag |
| `high` | Can cause significant harm or data exposure | Block or Escalate |
| `critical` | Immediate risk to users, data, or systems | Stop + Alert |

---

## 9. Audit-Only (Shadow) Mode

Before rolling out a new governance policy, run it in shadow mode:

```typescript
withGovernance({
  policy: newProductionPolicy,
  compliance,
  auditOnly: true,  // log decisions but never block execution
})
```

Compare the compliance stats of shadow mode vs. the active policy over 24–48 hours before switching.

---

## Quick Reference

| Need | Solution |
|------|---------|
| Enforce tool restrictions | `blockTools(["rm_rf", "drop_database"])` |
| Block secrets in outputs | `blockContentPatterns("no-secrets", [/sk-\w{20,}/])` |
| Wire into agent | `withGovernance({ policy, ethics, compliance, escalation })` |
| Standard ethical guardrails | `STANDARD_ETHICS_POLICY` |
| Custom ethics rule | `createEthicsPolicy({ rules: [...STANDARD_ETHICS_RULES, myRule] })` |
| Escalate on sensitive tools | `sensitiveToolTrigger(["send_email"])` |
| Escalate on low confidence | `lowConfidenceTrigger(0.5)` |
| Query compliance records | `compliance.query({ outcome: "blocked", since })` |
| Export for SIEM | `compliance.export()` |
| Forward records in real-time | `createComplianceTracker({ sink: { write: db.insert } })` |
| Propose governance change | `adaptation.propose("add", ruleId, rationale, proposerId, rule)` |
| Approve a proposal | `adaptation.approve(id, reviewerId)` |
| Detect violation rate spike | `adaptation.shouldTriggerReview(stats.violationRate)` |
| Shadow mode | `withGovernance({ auditOnly: true })` |
