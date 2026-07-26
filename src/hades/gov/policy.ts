/**
 * Declarative, signed governance policy for the Hades agent: rules over
 * subject/action/resource with structured conditions and obligations,
 * deterministic deny-overrides evaluation with a full explain trace, and a
 * linter that finds unreachable and contradictory rules.
 *
 * This module is deliberately independent of `./capability.ts` at runtime —
 * it imports only the `CapabilityRequest`/`CapabilityDecision` TYPES from
 * that module (type-only, erased at build time) so a policy decision can be
 * composed with a capability decision by a caller without creating a
 * runtime import cycle between the two governance layers. Crypto/canonical
 * primitives are shared with the rest of the governance stack via
 * `./identity.ts` (`govCanonicalize`, `govDigest`) — this module never signs
 * or verifies anything itself (that is `./policy-store.ts`'s job); it only
 * needs a stable content hash for `PolicyEngine.digest()`.
 *
 * ## Matching model
 *
 *  - `subjects` and `actions` are matched as whole strings: an entry of
 *    exactly `"*"` matches anything, otherwise it must equal the request's
 *    value exactly. There is no partial/segment wildcarding here because
 *    subject and action identifiers (`"agent:deadbeef"`, `"fs:write"`) are
 *    not inherently hierarchical from the matcher's point of view.
 *  - `resources` ARE matched hierarchically, the same way capability grants
 *    are: `:`-delimited top-level segments, with a final segment that looks
 *    like a filesystem path (starts with `/`) further split on `/`. A `*`
 *    segment matches exactly one segment; a `**` segment (only meaningful
 *    as the final pattern segment) matches everything remaining, including
 *    zero further segments. This lets `"fs:/workspace/**"` cover an entire
 *    subtree while `"tool:*"` covers exactly one tool name and nothing
 *    nested under it.
 *
 * ## Evaluation order (LOCKED, deterministic)
 *
 * Every rule is checked against the request; rules whose subjects/actions/
 * resources all match AND whose every condition is satisfied are "matched".
 * Among matched rules the winner is the FIRST one in this total order:
 *
 *   1. higher `priority` wins (missing priority defaults to `0`)
 *   2. at equal priority, `deny` beats `allow` (deny-overrides)
 *   3. at equal priority and effect, fewer wildcards wins (more specific)
 *   4. at equal priority, effect, and specificity, the earlier rule
 *      (lower array index) wins
 *
 * If no rule matches, `document().defaultEffect` applies and no obligations
 * are attached (there is no rule to attach them from). Obligations are
 * accumulated from every MATCHED rule that shares the winning rule's exact
 * `priority` AND `effect` (i.e. every rule that genuinely contributed to,
 * rather than lost to, the winning outcome), concatenated in ascending rule
 * index order.
 *
 * ## Statefulness
 *
 * The only condition kind with memory is `rate-limit`, tracked per
 * `(ruleId, subject)` as a sliding window of grant timestamps. `evaluate()`
 * consumes budget on a rule that matches and passes its rate-limit
 * condition (whether or not that rule ends up winning against a
 * higher-priority rule — it genuinely was an eligible use of that rule's
 * quota); `explain()` NEVER mutates rate-limit state, so calling it
 * repeatedly for "what would happen" purposes is side-effect free and its
 * trace is stable and reproducible across runs.
 */

import { govCanonicalize, govDigest } from "./identity";
import type { CapabilityDecision, CapabilityRequest } from "./capability";

// Re-exported so callers composing a policy decision with a capability
// decision do not need a second import purely for the type names — these
// are type-only re-exports and add nothing to the runtime bundle.
export type { CapabilityDecision, CapabilityRequest };

// ---------------------------------------------------------------------------
// Locked public types
// ---------------------------------------------------------------------------

export type PolicyEffect = "allow" | "deny";

export type PolicyCondition =
  | { kind: "time-window"; startMs: number; endMs: number }
  | { kind: "airgap"; required: boolean }
  | { kind: "capability"; resource: string }
  | { kind: "arg-equals"; arg: string; value: string | number | boolean }
  | { kind: "arg-matches"; arg: string; pattern: string }
  | { kind: "risk-budget"; minRemaining: number }
  | { kind: "identity-role"; role: string }
  | { kind: "rate-limit"; maxPerWindow: number; windowMs: number }
  | { kind: "resource-under"; root: string };

export type PolicyObligation =
  | { kind: "audit"; level: "summary" | "full" }
  | { kind: "abstain"; reason: string }
  | { kind: "require-capability"; resource: string }
  | { kind: "redact"; fields: readonly string[] }
  | { kind: "confirm"; prompt: string }
  | { kind: "rate-limited"; retryAfterMs: number };

export interface PolicyRule {
  id: string;
  description?: string;
  effect: PolicyEffect;
  subjects: readonly string[];
  actions: readonly string[];
  resources: readonly string[];
  conditions?: readonly PolicyCondition[];
  obligations?: readonly PolicyObligation[];
  priority?: number;
}

export interface PolicyDocument {
  schema: "hades.gov.policy.v1";
  name: string;
  version: number;
  defaultEffect: PolicyEffect;
  rules: readonly PolicyRule[];
}

export interface PolicyRequest {
  subject: string;
  subjectRoles?: readonly string[];
  action: string;
  resource: string;
  args?: Record<string, unknown>;
  at: number;
  airgapped?: boolean;
  riskRemaining?: number;
  capabilities?: readonly string[];
}

export interface PolicyTraceStep {
  ruleId: string;
  matched: boolean;
  reason: string;
  failedCondition?: PolicyCondition;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  ruleId?: string;
  reason: string;
  obligations: PolicyObligation[];
  trace: PolicyTraceStep[];
}

/** Structural port for audit emission — deliberately NOT `./audit-chain.ts`. */
export interface PolicyAuditSink {
  record(input: { at: number; actor: string; action: string; resource: string; outcome: "allow" | "deny" | "info"; code?: string; payload?: unknown }): void;
}

export interface PolicyLintFinding {
  code: "unreachable-rule" | "contradictory-rules" | "shadowed-rule" | "duplicate-id" | "empty-matcher" | "no-deny-default" | "unbounded-wildcard";
  ruleIds: string[];
  detail: string;
}

const SCHEMA = "hades.gov.policy.v1" as const;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ---------------------------------------------------------------------------
// Matching — see the module doc for the exact semantics.
// ---------------------------------------------------------------------------

/** Whole-string matcher for `subjects`/`actions`: `"*"` matches anything, otherwise exact equality. */
function matchesAnyLiteral(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => p === "*" || p === value);
}

/** Split a resource-pattern or resource string into hierarchical match segments (mirrors `capability.ts`). */
function splitResourceSegments(s: string): string[] {
  const top = s.split(":");
  const last = top[top.length - 1] ?? "";
  if (last.startsWith("/")) {
    const pathSegs = last.split("/").filter((seg) => seg.length > 0);
    return [...top.slice(0, -1), ...pathSegs];
  }
  return top;
}

function matchesResourcePattern(pattern: string, value: string): boolean {
  const pSegs = splitResourceSegments(pattern);
  const vSegs = splitResourceSegments(value);
  const caseInsensitive = pSegs[0] === "net";
  const norm = (x: string): string => (caseInsensitive ? x.toLowerCase() : x);

  let pi = 0;
  let vi = 0;
  while (pi < pSegs.length) {
    const p = pSegs[pi];
    if (p === "**") return true;
    if (vi >= vSegs.length) return false;
    const v = vSegs[vi];
    if (p !== "*" && norm(p) !== norm(v)) return false;
    pi++;
    vi++;
  }
  return vi === vSegs.length;
}

function matchesAnyResource(patterns: readonly string[], value: string): boolean {
  return patterns.some((p) => matchesResourcePattern(p, value));
}

// ---------------------------------------------------------------------------
// resource-under — hostile-input-safe path containment (mirrors capability.ts's
// `path-under` caveat; reimplemented locally rather than imported at runtime,
// per the type-only boundary this module keeps with `./capability.ts`).
// ---------------------------------------------------------------------------

function decodeRepeated(s: string, maxIterations = 5): string {
  let cur = s;
  for (let i = 0; i < maxIterations; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

function posixResolve(...parts: string[]): string {
  // Minimal dependency-free POSIX path resolver: avoids importing node:path
  // purely to keep this module's only external dependency as `./identity`.
  let resolved = "";
  let isAbsolute = false;
  for (let i = parts.length - 1; i >= 0 && !isAbsolute; i--) {
    const part = parts[i];
    if (part.length === 0) continue;
    resolved = part + "/" + resolved;
    isAbsolute = part.startsWith("/");
  }
  if (!isAbsolute) resolved = "/" + resolved;

  const segments = resolved.split("/");
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return "/" + out.join("/");
}

function pathIsUnder(root: string, candidatePath: string): boolean {
  const decoded = decodeRepeated(candidatePath);
  const normalizedRoot = posixResolve(root);
  const resolved = posixResolve(normalizedRoot, decoded);
  return resolved === normalizedRoot || resolved.startsWith(normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/");
}

// ---------------------------------------------------------------------------
// Specificity — lower score wins ties (fewer wildcards = more specific).
// ---------------------------------------------------------------------------

function flatWildcardScore(patterns: readonly string[]): number {
  return patterns.filter((p) => p === "*").length;
}

function resourceWildcardScore(patterns: readonly string[]): number {
  let score = 0;
  for (const p of patterns) {
    for (const seg of splitResourceSegments(p)) {
      if (seg === "**") score += 100;
      else if (seg === "*") score += 1;
    }
  }
  return score;
}

function ruleSpecificity(rule: PolicyRule): number {
  return flatWildcardScore(rule.subjects) + flatWildcardScore(rule.actions) + resourceWildcardScore(rule.resources);
}

// ---------------------------------------------------------------------------
// PolicyEngine
// ---------------------------------------------------------------------------

export class PolicyEngine {
  private readonly doc: PolicyDocument;
  private readonly now: () => number;
  private readonly audit: PolicyAuditSink | undefined;
  private readonly denyAllReason: string | null;
  /** `"<ruleId>::<subject>"` -> sorted-ascending grant timestamps still inside the window. */
  private readonly rateLimitState = new Map<string, number[]>();

  private constructor(doc: PolicyDocument, now: () => number, audit: PolicyAuditSink | undefined, denyAllReason: string | null) {
    this.doc = doc;
    this.now = now;
    this.audit = audit;
    this.denyAllReason = denyAllReason;
  }

  static compile(doc: PolicyDocument, opts: { now?: () => number; audit?: PolicyAuditSink } = {}): PolicyEngine {
    if (!isPlainObject(doc) || doc.schema !== SCHEMA) {
      throw new TypeError(`PolicyEngine.compile: doc.schema must be "${SCHEMA}"`);
    }
    if (!Array.isArray(doc.rules)) {
      throw new TypeError("PolicyEngine.compile: doc.rules must be an array");
    }
    const cloned = structuredClone(doc) as PolicyDocument;
    return new PolicyEngine(cloned, opts.now ?? (() => Date.now()), opts.audit, null);
  }

  /** A deny-everything engine, used whenever the policy store fails closed. */
  static denyAll(reason: string): PolicyEngine {
    const doc: PolicyDocument = { schema: SCHEMA, name: "deny-all", version: 0, defaultEffect: "deny", rules: [] };
    return new PolicyEngine(doc, () => Date.now(), undefined, reason);
  }

  document(): PolicyDocument {
    return structuredClone(this.doc);
  }

  digest(): string {
    return govDigest(this.document());
  }

  evaluate(req: PolicyRequest): PolicyDecision {
    return this.decide(req, true);
  }

  explain(req: PolicyRequest): PolicyDecision {
    return this.decide(req, false);
  }

  // -------------------------------------------------------------------------
  // Core decision
  // -------------------------------------------------------------------------

  private decide(req: PolicyRequest, mutate: boolean): PolicyDecision {
    if (this.denyAllReason !== null) {
      return { effect: "deny", reason: this.denyAllReason, obligations: [], trace: [] };
    }

    const trace: PolicyTraceStep[] = [];
    interface MatchedRule {
      rule: PolicyRule;
      index: number;
      priority: number;
      specificity: number;
    }
    const matched: MatchedRule[] = [];

    for (let i = 0; i < this.doc.rules.length; i++) {
      const rule = this.doc.rules[i]!;
      const step = this.matchRule(rule, req, mutate);
      trace.push(step);
      if (step.matched) {
        matched.push({ rule, index: i, priority: rule.priority ?? 0, specificity: ruleSpecificity(rule) });
      }
    }

    let effect: PolicyEffect;
    let ruleId: string | undefined;
    let reason: string;
    const obligations: PolicyObligation[] = [];

    if (matched.length === 0) {
      effect = this.doc.defaultEffect;
      reason = `no rule matched subject="${req.subject}" action="${req.action}" resource="${req.resource}"; default effect "${this.doc.defaultEffect}" applied`;
    } else {
      const sorted = [...matched].sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        if (a.rule.effect !== b.rule.effect) return a.rule.effect === "deny" ? -1 : 1;
        if (a.specificity !== b.specificity) return a.specificity - b.specificity;
        return a.index - b.index;
      });
      const winner = sorted[0]!;
      effect = winner.rule.effect;
      ruleId = winner.rule.id;
      const contributing = matched
        .filter((m) => m.priority === winner.priority && m.rule.effect === effect)
        .sort((a, b) => a.index - b.index);
      for (const m of contributing) {
        for (const ob of m.rule.obligations ?? []) obligations.push(ob);
      }
      reason = `rule "${winner.rule.id}" won (priority=${winner.priority}, effect=${effect}, specificity=${winner.specificity}) among ${matched.length} matched rule(s)`;
    }

    const decision: PolicyDecision = { effect, ruleId, reason, obligations, trace };

    if (mutate && this.audit) {
      try {
        this.audit.record({
          at: this.now(),
          actor: req.subject,
          action: req.action,
          resource: req.resource,
          outcome: effect,
          code: ruleId ?? "default",
          payload: { reason },
        });
      } catch {
        // An audit sink must never be able to break a policy decision.
      }
    }

    return decision;
  }

  private matchRule(rule: PolicyRule, req: PolicyRequest, mutate: boolean): PolicyTraceStep {
    if (!matchesAnyLiteral(rule.subjects, req.subject)) {
      return { ruleId: rule.id, matched: false, reason: `subject "${req.subject}" is not covered by rule.subjects` };
    }
    if (!matchesAnyLiteral(rule.actions, req.action)) {
      return { ruleId: rule.id, matched: false, reason: `action "${req.action}" is not covered by rule.actions` };
    }
    if (!matchesAnyResource(rule.resources, req.resource)) {
      return { ruleId: rule.id, matched: false, reason: `resource "${req.resource}" is not covered by rule.resources` };
    }
    for (const cond of rule.conditions ?? []) {
      const result = this.evalCondition(cond, req, rule.id, mutate);
      if (!result.ok) {
        return { ruleId: rule.id, matched: false, reason: result.reason, failedCondition: cond };
      }
    }
    return { ruleId: rule.id, matched: true, reason: `rule "${rule.id}" matched (effect=${rule.effect})` };
  }

  // -------------------------------------------------------------------------
  // Conditions
  // -------------------------------------------------------------------------

  private evalCondition(cond: PolicyCondition, req: PolicyRequest, ruleId: string, mutate: boolean): { ok: boolean; reason: string } {
    switch (cond.kind) {
      case "time-window": {
        const ok = req.at >= cond.startMs && req.at < cond.endMs;
        return { ok, reason: ok ? "" : `time-window: request at ${req.at} is outside [${cond.startMs}, ${cond.endMs})` };
      }
      case "airgap": {
        const isAirgapped = req.airgapped === true;
        const ok = cond.required ? isAirgapped : !isAirgapped;
        return { ok, reason: ok ? "" : `airgap: required=${cond.required} but request airgapped=${isAirgapped}` };
      }
      case "capability": {
        const held = req.capabilities ?? [];
        const ok = held.some((h) => matchesResourcePattern(h, cond.resource));
        return { ok, reason: ok ? "" : `capability: no held capability covers "${cond.resource}"` };
      }
      case "arg-equals": {
        const v = req.args ? req.args[cond.arg] : undefined;
        const ok = v === cond.value;
        return { ok, reason: ok ? "" : `arg-equals: args.${cond.arg} (${JSON.stringify(v)}) !== ${JSON.stringify(cond.value)}` };
      }
      case "arg-matches": {
        const v = req.args ? req.args[cond.arg] : undefined;
        let re: RegExp;
        try {
          re = new RegExp(cond.pattern);
        } catch {
          return { ok: false, reason: `arg-matches: invalid regex pattern "${cond.pattern}"` };
        }
        const ok = typeof v === "string" && re.test(v);
        return { ok, reason: ok ? "" : `arg-matches: args.${cond.arg} (${JSON.stringify(v)}) does not match /${cond.pattern}/` };
      }
      case "risk-budget": {
        const rr = req.riskRemaining;
        const ok = typeof rr === "number" && Number.isFinite(rr) && rr >= cond.minRemaining;
        return { ok, reason: ok ? "" : `risk-budget: riskRemaining (${String(rr)}) < minRemaining (${cond.minRemaining})` };
      }
      case "identity-role": {
        const ok = (req.subjectRoles ?? []).includes(cond.role);
        return { ok, reason: ok ? "" : `identity-role: subject does not hold role "${cond.role}"` };
      }
      case "rate-limit": {
        return this.evalRateLimit(cond, req, ruleId, mutate);
      }
      case "resource-under": {
        const p = req.args ? req.args["path"] : undefined;
        if (typeof p !== "string" || p.length === 0) {
          return { ok: false, reason: "resource-under: no args.path present on the request" };
        }
        const ok = pathIsUnder(cond.root, p);
        return { ok, reason: ok ? "" : `resource-under: path "${p}" escapes root "${cond.root}"` };
      }
      default: {
        const exhaustive: never = cond;
        return { ok: false, reason: `unrecognized condition kind "${String((exhaustive as { kind?: unknown })?.kind)}"` };
      }
    }
  }

  private evalRateLimit(cond: Extract<PolicyCondition, { kind: "rate-limit" }>, req: PolicyRequest, ruleId: string, mutate: boolean): { ok: boolean; reason: string } {
    const key = `${ruleId}::${req.subject}`;
    const existing = this.rateLimitState.get(key) ?? [];
    const cutoff = req.at - cond.windowMs;
    const active = existing.filter((t) => t > cutoff);
    const ok = active.length < cond.maxPerWindow;
    if (mutate) {
      if (ok) active.push(req.at);
      this.rateLimitState.set(key, active);
    }
    return { ok, reason: ok ? "" : `rate-limit: ${active.length}/${cond.maxPerWindow} calls already made in the last ${cond.windowMs}ms` };
  }

  // -------------------------------------------------------------------------
  // Linter
  // -------------------------------------------------------------------------

  lint(): PolicyLintFinding[] {
    const findings: PolicyLintFinding[] = [];
    const doc = this.doc;

    // duplicate-id
    const byId = new Map<string, number[]>();
    doc.rules.forEach((r, i) => {
      const arr = byId.get(r.id) ?? [];
      arr.push(i);
      byId.set(r.id, arr);
    });
    for (const [id, idxs] of byId) {
      if (idxs.length > 1) {
        findings.push({ code: "duplicate-id", ruleIds: [id], detail: `rule id "${id}" is reused by ${idxs.length} rules (indices ${idxs.join(", ")})` });
      }
    }

    // empty-matcher
    for (const r of doc.rules) {
      if (r.subjects.length === 0 || r.actions.length === 0 || r.resources.length === 0) {
        findings.push({ code: "empty-matcher", ruleIds: [r.id], detail: `rule "${r.id}" has an empty subjects/actions/resources array and can never match` });
      }
    }

    // no-deny-default
    if (doc.defaultEffect === "allow") {
      findings.push({ code: "no-deny-default", ruleIds: [], detail: `document "${doc.name}" defaultEffect is "allow"; least-privilege policies must default to "deny"` });
    }

    // unbounded-wildcard: an ALLOW rule with wildcard resources touching a destructive action
    for (const r of doc.rules) {
      if (r.effect !== "allow") continue;
      const touchesDestructiveOrAnyAction = r.actions.includes("*") || r.actions.some((a) => DESTRUCTIVE_ACTIONS.has(a));
      const wildcardResources = r.resources.includes("*") || r.resources.includes("**");
      if (touchesDestructiveOrAnyAction && wildcardResources) {
        findings.push({ code: "unbounded-wildcard", ruleIds: [r.id], detail: `rule "${r.id}" allows a destructive/wildcard action across an unbounded resource wildcard with no narrowing condition` });
      }
    }

    // contradictory-rules: identical matcher + condition signature, different effect
    const bySignature = new Map<string, PolicyRule[]>();
    for (const r of doc.rules) {
      const sig = govCanonicalize({
        subjects: [...r.subjects].sort(),
        actions: [...r.actions].sort(),
        resources: [...r.resources].sort(),
        conditions: [...(r.conditions ?? [])].map((c) => govCanonicalize(c)).sort(),
      });
      const arr = bySignature.get(sig) ?? [];
      arr.push(r);
      bySignature.set(sig, arr);
    }
    for (const group of bySignature.values()) {
      if (group.length < 2) continue;
      if (new Set(group.map((r) => r.effect)).size > 1) {
        findings.push({
          code: "contradictory-rules",
          ruleIds: group.map((r) => r.id),
          detail: `rules ${group.map((r) => `"${r.id}"`).join(", ")} share an identical matcher and condition set but disagree on effect`,
        });
      }
    }

    // unreachable-rule: a rule that a strictly-dominant catch-all always beats
    const catchAlls = doc.rules.filter((r) => r.subjects.includes("*") && r.actions.includes("*") && r.resources.includes("*") && (r.conditions ?? []).length === 0);
    for (const r of doc.rules) {
      for (const c of catchAlls) {
        if (c.id === r.id) continue;
        const cPriority = c.priority ?? 0;
        const rPriority = r.priority ?? 0;
        const dominates = cPriority > rPriority || (cPriority === rPriority && c.effect === "deny" && r.effect === "allow");
        if (dominates) {
          findings.push({
            code: "unreachable-rule",
            ruleIds: [r.id, c.id],
            detail: `rule "${r.id}" can never win: catch-all rule "${c.id}" (priority=${cPriority}, effect=${c.effect}) always dominates it`,
          });
        }
      }
    }

    // shadowed-rule: an unconditioned, broader (or equal) deny at >= priority covers a narrower allow
    for (const a of doc.rules) {
      if (a.effect !== "deny") continue;
      if ((a.conditions ?? []).length > 0) continue;
      const aIsCatchAll = a.subjects.includes("*") && a.actions.includes("*") && a.resources.includes("*");
      if (aIsCatchAll) continue; // already reported as unreachable-rule
      for (const b of doc.rules) {
        if (a.id === b.id || b.effect !== "allow") continue;
        if ((b.conditions ?? []).length > 0) continue;
        const aPriority = a.priority ?? 0;
        const bPriority = b.priority ?? 0;
        if (aPriority < bPriority) continue;
        const subjectsCovered = b.subjects.every((s) => matchesAnyLiteral(a.subjects, s));
        const actionsCovered = b.actions.every((s) => matchesAnyLiteral(a.actions, s));
        const resourcesCovered = b.resources.every((s) => matchesAnyResource(a.resources, s));
        if (subjectsCovered && actionsCovered && resourcesCovered) {
          findings.push({
            code: "shadowed-rule",
            ruleIds: [b.id, a.id],
            detail: `rule "${b.id}" (allow) is shadowed by broader deny rule "${a.id}", which covers the same or wider subjects/actions/resources at equal or higher priority`,
          });
        }
      }
    }

    return findings;
  }
}

const DESTRUCTIVE_ACTIONS = new Set(["fs:write", "net:egress", "spawn", "tool:invoke", "memory:write", "message:emit"]);

// ---------------------------------------------------------------------------
// parsePolicyDocument — strict, never throws
// ---------------------------------------------------------------------------

const KNOWN_CONDITION_KINDS: Record<string, (v: Record<string, unknown>) => string | null> = {
  "time-window": (v) =>
    typeof v.startMs === "number" && Number.isFinite(v.startMs) && typeof v.endMs === "number" && Number.isFinite(v.endMs)
      ? null
      : "startMs and endMs must be finite numbers",
  airgap: (v) => (typeof v.required === "boolean" ? null : "required must be a boolean"),
  capability: (v) => (isNonEmptyString(v.resource) ? null : "resource must be a non-empty string"),
  "arg-equals": (v) => (isNonEmptyString(v.arg) && ["string", "number", "boolean"].includes(typeof v.value) ? null : "arg must be a non-empty string and value must be string|number|boolean"),
  "arg-matches": (v) => (isNonEmptyString(v.arg) && typeof v.pattern === "string" ? null : "arg must be a non-empty string and pattern must be a string"),
  "risk-budget": (v) => (typeof v.minRemaining === "number" && Number.isFinite(v.minRemaining) ? null : "minRemaining must be a finite number"),
  "identity-role": (v) => (isNonEmptyString(v.role) ? null : "role must be a non-empty string"),
  "rate-limit": (v) =>
    typeof v.maxPerWindow === "number" && Number.isInteger(v.maxPerWindow) && v.maxPerWindow > 0 && typeof v.windowMs === "number" && Number.isFinite(v.windowMs) && v.windowMs > 0
      ? null
      : "maxPerWindow must be a positive integer and windowMs a positive number",
  "resource-under": (v) => (isNonEmptyString(v.root) ? null : "root must be a non-empty string"),
};

const KNOWN_OBLIGATION_KINDS: Record<string, (v: Record<string, unknown>) => string | null> = {
  audit: (v) => (v.level === "summary" || v.level === "full" ? null : 'level must be "summary" or "full"'),
  abstain: (v) => (typeof v.reason === "string" ? null : "reason must be a string"),
  "require-capability": (v) => (isNonEmptyString(v.resource) ? null : "resource must be a non-empty string"),
  redact: (v) => (Array.isArray(v.fields) && v.fields.length > 0 && v.fields.every((f) => typeof f === "string") ? null : "fields must be a non-empty array of strings"),
  confirm: (v) => (typeof v.prompt === "string" ? null : "prompt must be a string"),
  "rate-limited": (v) => (typeof v.retryAfterMs === "number" && Number.isFinite(v.retryAfterMs) ? null : "retryAfterMs must be a finite number"),
};

function validateCondition(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path}: condition must be an object`);
    return;
  }
  if (typeof v.kind !== "string") {
    errors.push(`${path}.kind: must be a string`);
    return;
  }
  const validator = KNOWN_CONDITION_KINDS[v.kind];
  if (!validator) {
    errors.push(`${path}.kind: unknown condition kind "${v.kind}"`);
    return;
  }
  const problem = validator(v);
  if (problem) errors.push(`${path}: ${problem}`);
}

function validateObligation(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path}: obligation must be an object`);
    return;
  }
  if (typeof v.kind !== "string") {
    errors.push(`${path}.kind: must be a string`);
    return;
  }
  const validator = KNOWN_OBLIGATION_KINDS[v.kind];
  if (!validator) {
    errors.push(`${path}.kind: unknown obligation kind "${v.kind}"`);
    return;
  }
  const problem = validator(v);
  if (problem) errors.push(`${path}: ${problem}`);
}

function validateStringArray(v: unknown, path: string, errors: string[], allowEmpty: boolean): void {
  if (!Array.isArray(v)) {
    errors.push(`${path}: must be an array of strings`);
    return;
  }
  if (!allowEmpty && v.length === 0) {
    errors.push(`${path}: must not be empty`);
    return;
  }
  v.forEach((s, i) => {
    if (typeof s !== "string" || s.length === 0) errors.push(`${path}[${i}]: must be a non-empty string`);
  });
}

function validateRule(v: unknown, path: string, errors: string[]): void {
  if (!isPlainObject(v)) {
    errors.push(`${path}: rule must be an object`);
    return;
  }
  if (!isNonEmptyString(v.id)) errors.push(`${path}.id: must be a non-empty string`);
  if (v.description !== undefined && typeof v.description !== "string") errors.push(`${path}.description: must be a string`);
  if (v.effect !== "allow" && v.effect !== "deny") errors.push(`${path}.effect: must be "allow" or "deny"`);
  validateStringArray(v.subjects, `${path}.subjects`, errors, false);
  validateStringArray(v.actions, `${path}.actions`, errors, false);
  validateStringArray(v.resources, `${path}.resources`, errors, false);
  if (v.conditions !== undefined) {
    if (!Array.isArray(v.conditions)) {
      errors.push(`${path}.conditions: must be an array`);
    } else {
      v.conditions.forEach((c, i) => validateCondition(c, `${path}.conditions[${i}]`, errors));
    }
  }
  if (v.obligations !== undefined) {
    if (!Array.isArray(v.obligations)) {
      errors.push(`${path}.obligations: must be an array`);
    } else {
      v.obligations.forEach((o, i) => validateObligation(o, `${path}.obligations[${i}]`, errors));
    }
  }
  if (v.priority !== undefined && (typeof v.priority !== "number" || !Number.isFinite(v.priority))) {
    errors.push(`${path}.priority: must be a finite number`);
  }
}

export function parsePolicyDocument(input: unknown): { ok: true; doc: PolicyDocument } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  try {
    if (!isPlainObject(input)) {
      return { ok: false, errors: ["$: policy document must be a plain object"] };
    }
    if (input.schema !== SCHEMA) {
      errors.push(`$.schema: must be "${SCHEMA}", got ${JSON.stringify(input.schema)}`);
    }
    if (typeof input.name !== "string" || input.name.length === 0) {
      errors.push("$.name: must be a non-empty string");
    }
    if (typeof input.version !== "number" || !Number.isInteger(input.version) || input.version < 0) {
      errors.push("$.version: must be a non-negative integer");
    }
    if (input.defaultEffect !== "allow" && input.defaultEffect !== "deny") {
      errors.push('$.defaultEffect: must be "allow" or "deny"');
    }
    if (!Array.isArray(input.rules)) {
      errors.push("$.rules: must be an array");
    } else {
      const seenIds = new Set<string>();
      const dupIds = new Set<string>();
      input.rules.forEach((r, i) => {
        validateRule(r, `$.rules[${i}]`, errors);
        if (isPlainObject(r) && isNonEmptyString(r.id)) {
          if (seenIds.has(r.id)) dupIds.add(r.id);
          seenIds.add(r.id);
        }
      });
      for (const id of dupIds) {
        errors.push(`$.rules: duplicate rule id "${id}"`);
      }
    }

    if (errors.length > 0) return { ok: false, errors };

    const rules = (input.rules as unknown[]).map((r) => {
      const rr = r as Record<string, unknown>;
      const rule: PolicyRule = {
        id: rr.id as string,
        effect: rr.effect as PolicyEffect,
        subjects: [...(rr.subjects as string[])],
        actions: [...(rr.actions as string[])],
        resources: [...(rr.resources as string[])],
        ...(rr.description !== undefined ? { description: rr.description as string } : {}),
        ...(rr.conditions !== undefined ? { conditions: rr.conditions as PolicyCondition[] } : {}),
        ...(rr.obligations !== undefined ? { obligations: rr.obligations as PolicyObligation[] } : {}),
        ...(rr.priority !== undefined ? { priority: rr.priority as number } : {}),
      };
      return rule;
    });

    const doc: PolicyDocument = {
      schema: SCHEMA,
      name: input.name as string,
      version: input.version as number,
      defaultEffect: input.defaultEffect as PolicyEffect,
      rules,
    };
    return { ok: true, doc };
  } catch (err) {
    return { ok: false, errors: [`$: internal parse error: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_GOV_POLICY — least privilege for this product's actual actions.
// ---------------------------------------------------------------------------

export const DEFAULT_GOV_POLICY: PolicyDocument = {
  schema: SCHEMA,
  name: "hades.default",
  version: 1,
  defaultEffect: "deny",
  rules: [
    {
      id: "allow-tool-invoke-registered",
      description: "Invoke a single named tool the requester already holds a capability for.",
      effect: "allow",
      subjects: ["*"],
      actions: ["tool:invoke"],
      resources: ["tool:*"],
      conditions: [{ kind: "capability", resource: "tool:*" }],
      obligations: [{ kind: "audit", level: "summary" }],
    },
    {
      id: "allow-fs-read-workspace",
      description: "Read anything under the workspace root.",
      effect: "allow",
      subjects: ["*"],
      actions: ["fs:read"],
      resources: ["fs:/workspace/**"],
      conditions: [{ kind: "resource-under", root: "/workspace" }],
      obligations: [{ kind: "audit", level: "summary" }],
    },
    {
      id: "allow-fs-write-scratch",
      description: "Write only under the disposable scratch subtree, and only with real risk budget remaining.",
      effect: "allow",
      subjects: ["*"],
      actions: ["fs:write"],
      resources: ["fs:/workspace/scratch/**"],
      conditions: [{ kind: "resource-under", root: "/workspace/scratch" }, { kind: "risk-budget", minRemaining: 0.05 }],
      obligations: [{ kind: "audit", level: "full" }, { kind: "confirm", prompt: "Confirm scratch-space write" }],
    },
    {
      id: "deny-net-egress-airgapped",
      description: "Air-gapped sessions may never reach the network, regardless of any held capability.",
      effect: "deny",
      priority: 100,
      subjects: ["*"],
      actions: ["net:egress"],
      resources: ["**"],
      conditions: [{ kind: "airgap", required: true }],
      obligations: [{ kind: "audit", level: "full" }],
    },
    {
      id: "allow-net-egress-allowlisted",
      description: "Egress to a single allowlisted host, only when not air-gapped and holding a net capability.",
      effect: "allow",
      subjects: ["*"],
      actions: ["net:egress"],
      resources: ["net:*"],
      conditions: [{ kind: "capability", resource: "net:*" }, { kind: "airgap", required: false }],
      obligations: [{ kind: "audit", level: "full" }],
    },
    {
      id: "allow-memory-write-scoped",
      description: "Write a single memory key matching a conservative safe-character allowlist.",
      effect: "allow",
      subjects: ["*"],
      actions: ["memory:write"],
      resources: ["memory:*"],
      conditions: [{ kind: "arg-matches", arg: "key", pattern: "^[a-zA-Z0-9_./-]+$" }],
      obligations: [{ kind: "audit", level: "summary" }],
    },
    {
      id: "allow-message-emit-throttled",
      description: "Emit a message, rate-limited to guard against runaway output loops.",
      effect: "allow",
      subjects: ["*"],
      actions: ["message:emit"],
      resources: ["message:*"],
      conditions: [{ kind: "rate-limit", maxPerWindow: 60, windowMs: 60_000 }],
      obligations: [{ kind: "audit", level: "summary" }],
    },
    {
      id: "allow-spawn-orchestrator-role",
      description: "Only an identity holding the orchestrator role, with real risk budget, may spawn a sub-agent.",
      effect: "allow",
      subjects: ["*"],
      actions: ["spawn"],
      resources: ["spawn:*"],
      conditions: [{ kind: "identity-role", role: "orchestrator" }, { kind: "risk-budget", minRemaining: 0.1 }],
      obligations: [{ kind: "audit", level: "full" }, { kind: "confirm", prompt: "Confirm agent spawn" }],
    },
  ],
};
