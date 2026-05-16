# 23 — Compliance and SOC 2

This document maps agent-harness controls to SOC 2 Trust Service Criteria (TSC).
Use it as evidence for your SOC 2 audit or as a checklist before a security review.

---

## Overview

agent-harness provides layered, composable security controls that map directly to SOC 2 Type II requirements. Each control is independently auditable and does not require changes to your core application logic.

| Control Layer | Implementation | Primary TSC |
|---|---|---|
| Logical access (tool-level) | Capability tokens, RBAC, `withSecurity` | CC6.1, CC6.3 |
| Revocation | `revokeToken`, `createRedisJtiStore` | CC6.3 |
| Event monitoring | `AuditLogger`, `createWebhookAuditSink` | CC7.2 |
| Change management | Governance policy, `blockTools` | CC8.1 |
| Data minimisation | `piiSanitizerGuardrail`, memory TTL | P3.1 |

---

## SOC 2 Trust Service Criteria Mapping

### CC6.1 — Logical and physical access controls

**Requirement:** The entity implements logical access security software, infrastructure, and architectures to protect against threats from sources outside its system boundaries.

**Controls provided:**

**Capability tokens** (`src/agents/security/capabilities.ts`)

Every agent run receives a short-lived, signed JWT that names exactly which tools the agent may call. The token is verified on every tool invocation — not just at session start.

```typescript
import { issueCapabilityToken } from "@/agents/security";

const token = await issueCapabilityToken({
  sub: userId,
  runId,
  tools: ["web_search", "get_page"],  // minimum required tools only
  ttl: "15m",
});
```

Tokens are signed with HS256 (symmetric secret) by default. Set `AGENT_CAPABILITY_PRIVATE_KEY` and `AGENT_CAPABILITY_PUBLIC_KEY` to use RS256 for environments where the issuer and verifier run as separate services.

**RBAC policy** (`src/agents/security/rbac.ts`)

Maps user roles to tool allow-lists. Deny always takes precedence over allow. Unknown roles are denied by default.

```typescript
import { createRbacPolicy } from "@/agents/security";

const policy = createRbacPolicy({
  roles: {
    admin:    { allow: ["*"] },
    operator: { allow: ["web_search", "get_page", "create_page"] },
    viewer:   { allow: ["get_page", "search_pages"] },
  },
  getUserRole: (ctx) => ctx.userRole as string,
  defaultRole: "viewer",
});
```

**Tool-level allow/deny** (`withSecurity`)

```typescript
import { withSecurity, createPolicy } from "@/agents/security";

withSecurity({
  policy: createPolicy({
    allow: ["web_search", "get_page"],
    deny:  ["shell_exec", "file_write", "drop_database"],
  }),
})
```

**Evidence for auditors:**
- All tool invocations go through `policy.enforce()` before execution.
- `PolicyViolationError` (code: `SECURITY_POLICY_VIOLATION`) is thrown and surfaced as an SSE error event with `code`, `toolName`, and `remediation`.
- Token verification rejects unknown algorithms (algorithm-confusion attack is structurally impossible with `jose`).

---

### CC6.3 — User access management

**Requirement:** Access to systems is removed when no longer required. Access is reviewed on a periodic basis.

**Controls provided:**

**Token issuance and short TTL**

Tokens default to 15-minute TTL (`AGENT_CAPABILITY_DEFAULT_TTL`). Long-lived service accounts are not supported by default — every run issues a fresh token.

**Explicit revocation** (`revokeToken`, `createRedisJtiStore`)

```typescript
import { revokeToken } from "@/agents/security";

// Revoke immediately on user deprovisioning
await revokeToken(jti, tokenExpiresAt);
```

For serverless deployments where in-memory revocations are lost between cold starts, wire up the Redis adapter:

```typescript
import { createRedisJtiStore, setJtiStore } from "@/agents/security";
import Redis from "ioredis";

// Call once at application startup
setJtiStore(createRedisJtiStore(new Redis(process.env.REDIS_URL!)));
```

Revoked JTIs are stored with TTL matching the token expiry, so the store self-cleans without a background sweep.

**JWKS key rotation** (`createJwksHandler`)

Mount a JWKS endpoint so distributed verifiers can rotate keys without redeployment:

```typescript
// src/app/api/jwks/route.ts
import { createJwksHandler } from "@/agents/security/jwks";
export const GET = createJwksHandler();
```

Verifiers in other services use `createRemoteJWKSet` from `jose` pointed at this URL.

**Evidence for auditors:**
- `verifyCapabilityToken` checks the JTI revocation store on every verification.
- `CapabilityError` with code `CAPABILITY_TOKEN_REVOKED` is thrown when a revoked token is presented.
- `CapabilityError` with code `CAPABILITY_TOKEN_EXPIRED` is thrown when an expired token is presented (jose enforces `exp` claim).

---

### CC7.2 — Security event monitoring

**Requirement:** The entity monitors system components and the operation of controls to detect anomalies and security incidents.

**Controls provided:**

**Audit logger** (`AuditLogger`, adapters)

Every allow/deny decision can be logged to any adapter implementing `AuditAdapter`:

```typescript
import { createAuditedPolicy, ConsoleAuditAdapter } from "@/agents/security";

const policy = createAuditedPolicy(
  { allow: ["web_search"], name: "search-policy" },
  new ConsoleAuditAdapter()
);
```

Available adapters: `ConsoleAuditAdapter`, `InMemoryAuditAdapter`, `NoopAuditAdapter`.

**Webhook audit sink** — ship events to SIEM

```typescript
import { createAuditedPolicy, createWebhookAuditSink } from "@/agents/security";

const policy = createAuditedPolicy(
  { allow: ["web_search"], name: "search-policy" },
  createWebhookAuditSink("https://siem.example.com/ingest", {
    secret: process.env.AUDIT_WEBHOOK_SECRET!,
  })
);
```

Each POST carries `X-Agent-Harness-Signature: sha256=<hmac-hex>` for receiver verification.

**Governance audit trail** (`withGovernance`)

The governance plugin independently logs every tool decision to its audit trail before execution. Combine with `auditOnly: true` during rollout to log before enforcing:

```typescript
import { withGovernance, DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance";

withGovernance({
  policy: DEFAULT_GOVERNANCE_POLICY,
  auditOnly: true,  // log violations without blocking — review before enforcing
})
```

**SSE error events with machine-readable codes**

Every blocked tool call emits a structured SSE error event:

```json
{ "type": "error", "code": "GOVERNANCE_POLICY_VIOLATION", "toolName": "shell_exec",
  "error": "Tool blocked by governance policy", "remediation": "..." }
```

Use `code` in your monitoring dashboards without parsing the human-readable `error` string.

**Evidence for auditors:**
- `AuditRecord` includes: `runId`, `agentName`, `toolName`, `userId`, `outcome`, `timestamp`, `policyName`, `reason`.
- Webhook deliveries are signed; receivers can verify authenticity without trusting the network path.
- All agent error events carry `code` for automated alerting rules.

---

### CC8.1 — Change management

**Requirement:** Infrastructure and software changes are authorised, tested, and approved before deployment.

**Controls provided:**

**Governance policy** (`withGovernance`, `createGovernancePolicy`)

A governance policy captures the list of permitted and blocked tools as code, making changes reviewable in pull requests:

```typescript
import { createGovernancePolicy, blockTools } from "@/agents/governance";

const policy = createGovernancePolicy({
  name: "production-v2",
  rules: [
    blockTools(["shell_exec", "file_delete", "drop_database"]),
  ],
  defaultOutcome: "allowed",
  onViolation: "block",
});
```

**Default governance policy** (`DEFAULT_GOVERNANCE_POLICY`)

The built-in policy blocks a curated list of high-risk tools (shell execution, database drops, file system writes outside sandboxes). Import and extend rather than starting from scratch:

```typescript
import { withGovernance, DEFAULT_GOVERNANCE_POLICY } from "@/agents/governance";
```

**`withControlPlane` — single production call**

Applies security + governance + observability in one plugin:

```typescript
import { withControlPlane } from "@/agents/plugins/control-plane";

createCustomHarness({
  plugins: [withControlPlane({
    denyTools: ["shell_exec"],
    governance: DEFAULT_GOVERNANCE_POLICY,
  })],
});
```

**Evidence for auditors:**
- Policy definitions are plain TypeScript objects — diff-able, version-controlled, code-reviewed.
- `GovernancePolicyViolationError` (code: `GOVERNANCE_POLICY_VIOLATION`) includes `toolName` for precise incident records.
- `auditOnly: true` allows shadowing new policies before enforcement, reducing change risk.

---

### P3.1 — Data minimisation and privacy

**Requirement:** Personal information is collected only to the extent necessary to fulfil the specified purpose.

**Controls provided:**

**PII sanitiser guardrail** (`piiSanitizerGuardrail`)

Strips PII patterns from agent inputs and outputs before they are processed or stored:

```typescript
import { withGuardrails, piiSanitizerGuardrail } from "@/agents/guardrails";

withGuardrails({
  input:  [piiSanitizerGuardrail()],
  output: [piiSanitizerGuardrail()],
})
```

Default patterns: email addresses, US SSNs, credit card numbers, phone numbers. Custom patterns can be added.

**Memory TTL and scope isolation**

```typescript
import { createMemoryManager } from "@/agents/memory";

const manager = createMemoryManager({
  adapter: memory,
  policy: {
    ttl: "30d",       // auto-expire memories after 30 days
    scope: "user",    // isolate memories per user (no cross-user leakage)
    topK: 5,          // retrieve only the most relevant memories
  },
});
```

**Evidence for auditors:**
- PII guardrail fires before data reaches the model and before data is written to memory.
- Memory TTL ensures personal data is not retained beyond the stated purpose.
- Memory scope isolation prevents one user's data being retrieved for another user's session.

---

## Quick-Start Compliance Checklist

Use this checklist before a SOC 2 audit or security review:

- [ ] **CC6.1** — All production agent runs issue a capability token with the minimum required tool list (`tools: [...]`, not `tools: ["*"]`).
- [ ] **CC6.3** — `setJtiStore(createRedisJtiStore(...))` is called at startup in all serverless/edge deployments. In-memory JTI store is not used in production.
- [ ] **CC7.2** — An `AuditAdapter` is wired to every `createAuditedPolicy` call. Webhook sink is configured to ship events to your SIEM.
- [ ] **CC8.1** — Governance policy is defined in code (not ad-hoc). Reviewed in PR before each deployment.
- [ ] **P3.1** — `piiSanitizerGuardrail()` is applied to both input and output guardrail arrays for any agent that handles user-provided text.

---

## Environment Variables Reference

| Variable | Required | Purpose |
|---|---|---|
| `AGENT_CAPABILITY_SECRET` | Yes (HS256) | Symmetric secret for signing/verifying capability tokens. Min 32 chars. |
| `AGENT_CAPABILITY_PRIVATE_KEY` | Yes (RS256) | PEM RSA private key. Set with PUBLIC_KEY to enable RS256. |
| `AGENT_CAPABILITY_PUBLIC_KEY` | Yes (RS256) | PEM RSA public key. Set with PRIVATE_KEY to enable RS256. |
| `AGENT_CAPABILITY_DEFAULT_TTL` | No | Default token TTL, e.g. `"15m"`. Default: `"15m"`. |
| `AGENT_JTI_STORE` | No | Signals that a durable JTI store is configured (informational). |
| `REDIS_URL` | No | Redis connection string for `createRedisJtiStore`. |
| `AUDIT_WEBHOOK_SECRET` | No | HMAC secret for signing audit webhook payloads. |
| `MEMORY_PROVIDER` | No | `"memory"` \| `"pgvector"` \| `"pinecone"`. Default: `"memory"`. |
| `VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` | — | Detected automatically; triggers serverless foot-gun warnings. |

---

## Related Guides

| Guide | What it covers |
|---|---|
| [18 — Governance playbook](18-governance-playbook.md) | Policy authoring, ethics checks, escalation |
| [22 — Go to production](22-go-to-production.md) | Redis, routing, deployment checklist |
| [03 — Building tools](03-building-tools.md) | Tool authorization patterns |
