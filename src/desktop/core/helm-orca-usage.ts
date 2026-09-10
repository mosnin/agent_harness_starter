import { createHash } from "node:crypto";

export type HelmOrcaUsageObservation = {
  provider: "claude";
  identity: {
    sessionId: string;
    runtimeId: string;
    dispatchId: string;
    acquisitionGeneration: string;
    fence: number;
    providerSessionId: string;
    turnId: string | null;
  };
  eventId: string;
  scope: "provider-result";
  aggregation: "unknown";
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCostUsd: number | null;
  reportedTurns: number | null;
  cache: { readTokens: null; creationTokens: null; relationToInput: "unknown" };
  completeness: "partial";
};
export type HelmOrcaUsageRow = {
  observation: HelmOrcaUsageObservation;
  observedAt: number;
  observationKey: string;
  payloadHash: string;
  conflict: boolean;
};
export type HelmOrcaUsageDecodeResult =
  | { state: "unsupported" }
  | {
      state: "unavailable";
      reason:
        | "identity_unproven"
        | "owning_host_required"
        | "unsupported_or_unattached"
        | "identity_mismatch"
        | "journal_unavailable"
        | "cursor_invalidated";
    }
  | { state: "malformed"; reason: "invalid_projection" }
  | { state: "mismatch"; reason: "dispatch_or_session" }
  | {
      state: "available";
      version: 1 | 2;
      nextCursor?: string;
      dispatchId: string;
      sessionId: string;
      aggregation: "unknown";
      observations: HelmOrcaUsageRow[];
      conflict: boolean;
      truncated: boolean;
    };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(
  value: unknown,
  expected: string[],
): value is Record<string, unknown> {
  return (
    object(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function id(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableCount = (value: unknown): value is number | null =>
  value === null || count(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function observation(value: unknown): HelmOrcaUsageObservation | null {
  if (
    !keys(value, [
      "provider",
      "identity",
      "eventId",
      "scope",
      "aggregation",
      "inputTokens",
      "outputTokens",
      "reportedCostUsd",
      "reportedTurns",
      "cache",
      "completeness",
    ])
  )
    return null;
  const i = value.identity;
  if (
    !keys(i, [
      "sessionId",
      "runtimeId",
      "dispatchId",
      "acquisitionGeneration",
      "fence",
      "providerSessionId",
      "turnId",
    ]) ||
    !id(i.sessionId) ||
    !id(i.runtimeId) ||
    !id(i.dispatchId) ||
    !id(i.acquisitionGeneration) ||
    !id(i.providerSessionId) ||
    !count(i.fence) ||
    !(i.turnId === null || id(i.turnId)) ||
    !id(value.eventId)
  )
    return null;
  if (
    value.provider !== "claude" ||
    value.scope !== "provider-result" ||
    value.aggregation !== "unknown" ||
    value.completeness !== "partial" ||
    !nullableCount(value.inputTokens) ||
    !nullableCount(value.outputTokens) ||
    !nullableCount(value.reportedTurns) ||
    !(
      value.reportedCostUsd === null ||
      (typeof value.reportedCostUsd === "number" &&
        Number.isFinite(value.reportedCostUsd) &&
        value.reportedCostUsd >= 0 &&
        value.reportedCostUsd <= Number.MAX_SAFE_INTEGER)
    ) ||
    !keys(value.cache, ["readTokens", "creationTokens", "relationToInput"]) ||
    value.cache.readTokens !== null ||
    value.cache.creationTokens !== null ||
    value.cache.relationToInput !== "unknown"
  )
    return null;
  // Property order is the pinned Orca parser's canonical payload order, not transport key order.
  return {
    provider: "claude",
    identity: {
      sessionId: i.sessionId,
      runtimeId: i.runtimeId,
      dispatchId: i.dispatchId,
      acquisitionGeneration: i.acquisitionGeneration,
      fence: i.fence,
      providerSessionId: i.providerSessionId,
      turnId: i.turnId,
    },
    eventId: value.eventId,
    scope: "provider-result",
    aggregation: "unknown",
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    reportedCostUsd: value.reportedCostUsd,
    reportedTurns: value.reportedTurns,
    cache: {
      readTokens: null,
      creationTokens: null,
      relationToInput: "unknown",
    },
    completeness: "partial",
  };
}

/** Validates transport evidence only; the caller must separately prove the exact worker/runtime/base. */
export function decodeHelmOrcaUsage(
  value: unknown,
  expected: { dispatchId: string; sessionId: string },
): HelmOrcaUsageDecodeResult {
  if (value === undefined) return { state: "unsupported" };
  const malformed = (): HelmOrcaUsageDecodeResult => ({
    state: "malformed",
    reason: "invalid_projection",
  });
  const mismatch = (): HelmOrcaUsageDecodeResult => ({
    state: "mismatch",
    reason: "dispatch_or_session",
  });
  if (
    !object(value) ||
    (value.version !== 1 && value.version !== 2) ||
    value.aggregation !== "unknown" ||
    !id(value.dispatchId)
  )
    return malformed();
  if (
    !id(expected.dispatchId) ||
    !id(expected.sessionId) ||
    value.dispatchId !== expected.dispatchId
  )
    return mismatch();
  if (value.state === "unavailable") {
    if (
      !keys(value, [
        "version",
        "dispatchId",
        "aggregation",
        "state",
        "reason",
      ]) ||
      typeof value.reason !== "string" ||
      ![
        "identity_unproven",
        "owning_host_required",
        "unsupported_or_unattached",
        "identity_mismatch",
        "journal_unavailable",
        ...(value.version === 2 ? ["cursor_invalidated"] : []),
      ].includes(value.reason)
    )
      return malformed();
    return {
      state: "unavailable",
      reason: value.reason as Extract<
        HelmOrcaUsageDecodeResult,
        { state: "unavailable" }
      >["reason"],
    };
  }
  if (
    !keys(value, [
      "version",
      "dispatchId",
      "aggregation",
      "state",
      "sessionId",
      "observations",
      "conflict",
      "truncated",
      ...(value.version === 2 ? ["nextCursor"] : []),
    ]) ||
    value.state !== "available" ||
    !id(value.sessionId) ||
    !Array.isArray(value.observations) ||
    value.observations.length > 100 ||
    typeof value.conflict !== "boolean" ||
    typeof value.truncated !== "boolean" ||
    (value.version === 2 &&
      (typeof value.nextCursor !== "string" ||
        !/^[A-Za-z0-9_-]{1,2048}$/.test(value.nextCursor)))
  )
    return malformed();
  if (value.sessionId !== expected.sessionId) return mismatch();
  const rows: HelmOrcaUsageRow[] = [];
  const seen = new Set<string>();
  for (const row of value.observations) {
    if (
      !keys(row, [
        "observation",
        "observedAt",
        "observationKey",
        "payloadHash",
        "conflict",
      ]) ||
      !count(row.observedAt) ||
      typeof row.conflict !== "boolean" ||
      typeof row.observationKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.observationKey) ||
      typeof row.payloadHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.payloadHash)
    )
      return malformed();
    const o = observation(row.observation);
    if (!o) return malformed();
    if (o.identity.sessionId !== expected.sessionId) return mismatch();
    const i = o.identity;
    const key = hash(
      JSON.stringify([
        o.provider,
        o.eventId,
        i.sessionId,
        i.providerSessionId,
        i.dispatchId,
        i.runtimeId,
        i.acquisitionGeneration,
        i.turnId,
      ]),
    );
    if (
      key !== row.observationKey ||
      hash(JSON.stringify(o)) !== row.payloadHash ||
      seen.has(key + row.payloadHash)
    )
      return malformed();
    seen.add(key + row.payloadHash);
    if (row.conflict && !value.conflict) return malformed();
    rows.push({
      observation: o,
      observedAt: row.observedAt,
      observationKey: key,
      payloadHash: row.payloadHash,
      conflict: row.conflict,
    });
  }
  for (const row of rows)
    if (
      rows.some(
        (other) =>
          other.observationKey === row.observationKey &&
          other.payloadHash !== row.payloadHash,
      ) &&
      !row.conflict
    )
      return malformed();
  return {
    state: "available",
    version: value.version,
    ...(value.version === 2 ? { nextCursor: value.nextCursor as string } : {}),
    dispatchId: expected.dispatchId,
    sessionId: expected.sessionId,
    aggregation: "unknown",
    observations: rows,
    conflict: value.conflict,
    truncated: value.truncated,
  };
}
