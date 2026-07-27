/**
 * A genuine air-gap: interdiction of the actual egress SEAMS a Node process
 * can reach the network through, not merely an "un-provisioned" agent that
 * happens not to have been given a network tool.
 *
 * Six seams are covered: `fetch` (the WHATWG global), `http`/`https`
 * (`request`/`get`), `net-socket` (`net.connect`, `net.createConnection`,
 * and `net.Socket.prototype.connect` — a caller reaching straight for a raw
 * TCP socket bypasses every higher-level wrapper, so this is the seam that
 * actually matters), `dns` (name resolution — blocking it defeats even a
 * caller that tries to resolve a hostname before dialing it by hand), and
 * `tls` (`tls.connect`).
 *
 * ## Honesty discipline
 *
 * This module never claims a security property it did not actually perform.
 * Every seam is independently probed for whether it can be *durably and
 * exactly* neutralized:
 *
 *  - `"patched"`     — the seam's entry points exist and were replaced with
 *                       a guard that throws {@link AirgapViolationError}
 *                       before any original implementation runs, and can be
 *                       restored EXACTLY (`===` its original) on release.
 *  - `"absent"`       — the seam's entry points do not exist in this target
 *                       at all (nothing to exploit, nothing to guard).
 *  - `"unavailable"`  — the seam's entry points exist but are frozen /
 *                       non-configurable / non-writable and cannot be safely
 *                       replaced. This is reported HONESTLY, lands in
 *                       {@link AirgapReport.unverifiableSeams}, and forces
 *                       {@link AirgapReport.sealed} to `false` — there is no
 *                       code path that silently treats an unavailable seam
 *                       as neutralized.
 *
 * `sealed` is `true` if and only if EVERY requested seam resolved to
 * `"patched"` or `"absent"`. There is no other way to get `sealed: true`.
 *
 * ## Testability — `AirgapTarget`
 *
 * `engageAirgap()` and `probeAirgap()` accept an injectable
 * {@link AirgapTarget} — the exact seam surface (a `globals` bag plus the
 * `http`/`https`/`net`/`dns`/`tls` module-shaped objects) to patch. Tests
 * build a synthetic target and never touch the live process. Calling
 * `engageAirgap()` with NO target patches the REAL runtime: the actual
 * `globalThis.fetch` and the actual singleton `node:http`/`node:https`/
 * `node:net`/`node:dns`/`node:tls` module objects obtained via
 * `createRequire` (never a frozen ESM namespace view — see the comment on
 * {@link realAirgapTarget} for why that distinction is load-bearing), and
 * restores every original reference EXACTLY on `release()`.
 *
 * ## Policy exceptions
 *
 * `AirgapPolicy.allowLoopback` / `allowUnixSocket` / `allowHosts` are the
 * ONLY way an intercepted call is allowed through (in which case the
 * original implementation is actually invoked). Host matching is
 * exact-string, case-insensitive, after parsing through the WHATWG `URL`
 * class where the target looks like a URL — which is what defeats a
 * `http://evil@allowed.host/` userinfo trick: `new URL(...).hostname`
 * already strips userinfo and normalizes the actual host, so a naive
 * substring/prefix check is never used here.
 */

import { createRequire } from "node:module";

// ---------------------------------------------------------------------------
// Locked public types
// ---------------------------------------------------------------------------

export type EgressSeam = "fetch" | "http" | "https" | "net-socket" | "dns" | "tls";

export interface AirgapPolicy {
  allowLoopback?: boolean;
  allowUnixSocket?: boolean;
  allowHosts?: readonly string[];
  seams?: readonly EgressSeam[];
}

export interface EgressAttempt {
  seam: EgressSeam;
  target: string;
  at: number;
  blocked: boolean;
  reason: string;
}

export class AirgapViolationError extends Error {
  readonly seam: EgressSeam;
  readonly target: string;

  constructor(seam: EgressSeam, target: string, reason: string) {
    super(`air-gap violation: blocked ${seam} egress to "${target}" — ${reason}`);
    this.name = "AirgapViolationError";
    this.seam = seam;
    this.target = target;
  }
}

export interface SeamStatus {
  seam: EgressSeam;
  neutralized: boolean;
  how: "patched" | "absent" | "unavailable";
  detail: string;
}

export interface AirgapReport {
  sealed: boolean;
  seams: SeamStatus[];
  unverifiableSeams: EgressSeam[];
  attempts: EgressAttempt[];
  policy: AirgapPolicy;
}

export interface AirgapSession {
  report(): AirgapReport;
  attempts(): EgressAttempt[];
  release(): void;
}

/**
 * The injectable seam surface. `globals` is a bag exposing (at least)
 * `fetch` — in production this is `globalThis` itself, cast down to this
 * shape, so mutating `target.globals.fetch` IS mutating `globalThis.fetch`.
 * `http`/`https`/`net`/`dns`/`tls` are `unknown` on purpose: tests hand in a
 * plain object shaped like the corresponding module (only the properties
 * this module actually reads/patches need to exist), and production hands
 * in the real, mutable, singleton module-exports objects.
 */
export interface AirgapTarget {
  globals: { fetch?: unknown };
  http?: unknown;
  https?: unknown;
  net?: unknown;
  dns?: unknown;
  tls?: unknown;
}

// ---------------------------------------------------------------------------
// ALL_EGRESS_SEAMS — fixed, documented order every report uses
// ---------------------------------------------------------------------------

export const ALL_EGRESS_SEAMS: readonly EgressSeam[] = ["fetch", "http", "https", "net-socket", "dns", "tls"];

// ---------------------------------------------------------------------------
// Live-session registry
// ---------------------------------------------------------------------------

/**
 * Every session `engageAirgap` hands out that has NOT yet been released, in
 * engagement order. This is the ONLY honest answer to "is this process
 * currently air-gapped?" — an operator surface must read it rather than
 * printing a hardcoded "no", because a session engaged anywhere in the
 * process (a `withAirgap` block on another stack frame, an in-flight
 * `runAirgappedTask`) is genuinely in force for the whole process.
 *
 * A session registers itself only if it actually patched at least one seam
 * against the REAL runtime; a session engaged against an injected test
 * target never claims the process is sealed.
 */
const liveSessions: AirgapSession[] = [];

/** Live, unreleased air-gap sessions currently in force in THIS process, in engagement order. */
export function activeAirgapSessions(): readonly AirgapSession[] {
  return [...liveSessions];
}

const DNS_FUNCTION_KEYS: readonly string[] = [
  "lookup",
  "resolve",
  "resolve4",
  "resolve6",
  "resolveCname",
  "resolveMx",
  "resolveTxt",
  "resolveSrv",
  "resolveNs",
  "resolvePtr",
  "resolveSoa",
  "resolveNaptr",
  "resolveCaa",
  "reverse",
];

// ---------------------------------------------------------------------------
// Real-runtime target
// ---------------------------------------------------------------------------

/**
 * Build the target that patches the ACTUAL running process.
 *
 * Deliberately uses `createRequire` rather than `import * as X from
 * "node:http"`: under real ECMAScript module semantics a namespace object's
 * own properties are non-writable/non-configurable bindings (a *view* over
 * the underlying module), so `httpNamespace.request = guard` either throws
 * or silently no-ops depending on the runtime — it can NEVER durably
 * intercept calls other code in the process makes through that same module.
 * `createRequire(...)("node:http")` instead returns the actual CommonJS
 * `module.exports` object — a single, ordinary, mutable object that Node
 * caches once per process and that BOTH `require("node:http")` callers and
 * `import ... from "node:http"` callers ultimately read through (Node's ESM
 * facade for a built-in module is a set of live getters over this same
 * underlying object) — so patching it here genuinely intercepts calls made
 * anywhere else in the process, not just calls made through this module's
 * own reference.
 */
function realAirgapTarget(): AirgapTarget {
  // Dual-format guard (duplicated in migrate/fixtures.ts on purpose — a shared
  // helper would be this file's ONLY repo-internal import): in the CJS bundle
  // (scripts/build-hades.mjs, format "cjs") esbuild leaves `import.meta` as an
  // empty object, so `import.meta.url` is `undefined` and
  // `createRequire(undefined)` throws — there `__filename` is the real module
  // path. Under genuine ESM `__filename` is undeclared, but `typeof` on an
  // undeclared identifier never throws, so the check falls through to
  // `import.meta.url`, which is the one that exists in that format.
  const req = createRequire(typeof __filename === "string" ? __filename : import.meta.url);
  return {
    globals: globalThis as unknown as { fetch?: unknown },
    http: req("node:http") as unknown,
    https: req("node:https") as unknown,
    net: req("node:net") as unknown,
    dns: req("node:dns") as unknown,
    tls: req("node:tls") as unknown,
  };
}

// ---------------------------------------------------------------------------
// Host / target extraction — deliberately conservative (exact-string,
// URL-parsed) so it can never be tricked into treating a disallowed host as
// allowed.
// ---------------------------------------------------------------------------

function isUrlLike(s: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s);
}

/** Best-effort human-readable description of what a call was trying to reach — used for attempt logs and allow/deny matching. Never throws. */
function describeTarget(seam: EgressSeam, args: readonly unknown[]): string {
  if (seam === "dns") {
    const hostname = args[0];
    return typeof hostname === "string" ? hostname : "unknown";
  }

  const first = args[0];

  if (typeof first === "string") {
    if ((seam === "net-socket" || seam === "tls") && !isUrlLike(first)) {
      // net/tls string-only calls are `connect(path[, cb])` — a UNIX domain
      // socket path — UNLESS a host string follows as args[1].
      if (typeof args[1] !== "string") return `unix:${first}`;
    }
    return first;
  }

  if (first instanceof URL) return first.href;

  if (first !== null && typeof first === "object") {
    const o = first as Record<string, unknown>;
    if (typeof o.href === "string") return o.href;
    if (typeof o.url === "string") return o.url;
    const host = (o.hostname ?? o.host) as unknown;
    const port = o.port as unknown;
    if (typeof host === "string" && host.length > 0) {
      return port !== undefined && port !== null && port !== "" ? `${host}:${String(port)}` : host;
    }
    if (typeof o.path === "string") return `unix:${o.path}`;
  }

  if (typeof first === "number" && typeof args[1] === "string") {
    return `${args[1]}:${first}`;
  }
  if (typeof first === "number") {
    // net.connect(port[, cb]) / tls.connect(port[, cb]) with no host defaults to localhost per Node's own docs.
    return `localhost:${first}`;
  }

  return "unknown";
}

/** Strip the WHATWG URL parser's surrounding `[...]` bracket notation for IPv6 literals — a pure notational normalization, not a case-fold or an alias. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

function extractHostname(target: string): string | null {
  if (target.startsWith("unix:")) return null;
  try {
    if (isUrlLike(target)) {
      return stripIpv6Brackets(new URL(target).hostname.toLowerCase());
    }
  } catch {
    return null;
  }
  const hostPart = target.split(":")[0] ?? "";
  return hostPart.length > 0 ? hostPart.toLowerCase() : null;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.startsWith("127.");
}

interface ResolvedPolicy {
  allowLoopback: boolean;
  allowUnixSocket: boolean;
  allowHosts: readonly string[];
  seams: readonly EgressSeam[];
}

function isAllowedTarget(target: string, policy: ResolvedPolicy): { allowed: boolean; reason: string } {
  if (target.startsWith("unix:")) {
    if (policy.allowUnixSocket) {
      return { allowed: true, reason: "unix domain socket connections are allowed by policy.allowUnixSocket" };
    }
    return { allowed: false, reason: "unix domain socket connections are blocked (policy.allowUnixSocket=false)" };
  }

  const hostname = extractHostname(target);
  if (hostname !== null) {
    if (policy.allowLoopback && isLoopbackHostname(hostname)) {
      return { allowed: true, reason: `loopback host "${hostname}" is allowed by policy.allowLoopback` };
    }
    const lowerAllow = policy.allowHosts.map((h) => h.toLowerCase());
    if (lowerAllow.includes(hostname)) {
      return { allowed: true, reason: `host "${hostname}" is in policy.allowHosts (exact match)` };
    }
    return {
      allowed: false,
      reason: `host "${hostname}" is not loopback-allowed and is not in policy.allowHosts`,
    };
  }

  return { allowed: false, reason: `target "${target}" could not be resolved to a host; blocked by default` };
}

// ---------------------------------------------------------------------------
// Property-level patch primitive — the ONE place a live property is ever
// replaced or restored. Handles every descriptor shape a real module or a
// hostile synthetic test target can present, and never fabricates a restore
// path it cannot actually honor.
// ---------------------------------------------------------------------------

type PatchOutcome =
  | { status: "patched"; restore: () => void; note: string }
  | { status: "absent"; note: string }
  | { status: "unavailable"; note: string };

function patchFunctionProperty(holder: unknown, key: string, seam: EgressSeam, makeGuard: (seam: EgressSeam, original: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown): PatchOutcome {
  if (holder === null || (typeof holder !== "object" && typeof holder !== "function")) {
    return { status: "absent", note: `${key}: holder is missing` };
  }
  const rec = holder as Record<string, unknown>;
  const original = rec[key];
  if (typeof original !== "function") {
    return { status: "absent", note: `${key}: not present as a function` };
  }
  const descriptor = Object.getOwnPropertyDescriptor(rec, key);
  if (!descriptor) {
    // A function value visible only through the prototype chain, not as an
    // own property here — we refuse to shadow it invisibly; report honestly.
    return { status: "unavailable", note: `${key}: present but not an own property (inherited) — cannot be safely neutralized here` };
  }

  const guard = makeGuard(seam, original as (...a: unknown[]) => unknown);

  if (descriptor.configurable) {
    Object.defineProperty(rec, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      writable: true,
      value: guard,
    });
    return {
      status: "patched",
      restore: () => Object.defineProperty(rec, key, descriptor),
      note: `${key}: patched (configurable, exact restore)`,
    };
  }
  if (descriptor.writable === true) {
    rec[key] = guard;
    const originalValue = descriptor.value;
    return {
      status: "patched",
      restore: () => {
        rec[key] = originalValue;
      },
      note: `${key}: patched (writable, non-configurable)`,
    };
  }
  if (typeof descriptor.set === "function") {
    rec[key] = guard;
    return {
      status: "patched",
      restore: () => {
        rec[key] = original;
      },
      note: `${key}: patched via accessor setter`,
    };
  }
  return { status: "unavailable", note: `${key}: frozen / non-configurable / non-writable — cannot be neutralized` };
}

interface SeamPatchResult {
  how: "patched" | "absent" | "unavailable";
  detail: string;
  restores: Array<() => void>;
}

function aggregateSeam(points: readonly PatchOutcome[]): SeamPatchResult {
  const restores = points.flatMap((p) => (p.status === "patched" ? [p.restore] : []));
  const how: SeamPatchResult["how"] = points.some((p) => p.status === "unavailable")
    ? "unavailable"
    : points.some((p) => p.status === "patched")
      ? "patched"
      : "absent";
  const detail = points.length > 0 ? points.map((p) => p.note).join("; ") : "no patch points defined for this seam";
  return { how, detail, restores };
}

function protoOf(ctor: unknown): unknown {
  if (ctor === null) return undefined;
  if (typeof ctor === "function" || typeof ctor === "object") {
    return (ctor as { prototype?: unknown }).prototype;
  }
  return undefined;
}

function neutralizeSeam(
  seam: EgressSeam,
  target: AirgapTarget,
  makeGuard: (seam: EgressSeam, original: (...a: unknown[]) => unknown) => (...a: unknown[]) => unknown,
): SeamPatchResult {
  switch (seam) {
    case "fetch":
      return aggregateSeam([patchFunctionProperty(target.globals, "fetch", seam, makeGuard)]);
    case "http":
      return aggregateSeam(["request", "get"].map((k) => patchFunctionProperty(target.http, k, seam, makeGuard)));
    case "https":
      return aggregateSeam(["request", "get"].map((k) => patchFunctionProperty(target.https, k, seam, makeGuard)));
    case "net-socket": {
      const netObj = target.net as Record<string, unknown> | undefined;
      const points = [
        patchFunctionProperty(netObj, "connect", seam, makeGuard),
        patchFunctionProperty(netObj, "createConnection", seam, makeGuard),
        patchFunctionProperty(protoOf(netObj?.Socket), "connect", seam, makeGuard),
      ];
      return aggregateSeam(points);
    }
    case "dns": {
      const dnsObj = target.dns as Record<string, unknown> | undefined;
      const topPoints = DNS_FUNCTION_KEYS.map((k) => patchFunctionProperty(dnsObj, k, seam, makeGuard));
      const promisesObj = dnsObj?.promises as Record<string, unknown> | undefined;
      const promisePoints = DNS_FUNCTION_KEYS.map((k) => patchFunctionProperty(promisesObj, k, seam, makeGuard));
      return aggregateSeam([...topPoints, ...promisePoints]);
    }
    case "tls":
      return aggregateSeam([patchFunctionProperty(target.tls, "connect", seam, makeGuard)]);
  }
}

// ---------------------------------------------------------------------------
// engageAirgap / withAirgap / probeAirgap
// ---------------------------------------------------------------------------

export function engageAirgap(opts?: {
  policy?: AirgapPolicy;
  now?: () => number;
  onAttempt?: (a: EgressAttempt) => void;
  target?: AirgapTarget;
}): AirgapSession {
  const resolvedPolicy: ResolvedPolicy = {
    allowLoopback: opts?.policy?.allowLoopback ?? false,
    allowUnixSocket: opts?.policy?.allowUnixSocket ?? false,
    allowHosts: opts?.policy?.allowHosts ?? [],
    seams: opts?.policy?.seams ?? ALL_EGRESS_SEAMS,
  };
  const nowFn = opts?.now ?? (() => Date.now());
  const onAttempt = opts?.onAttempt;
  const target: AirgapTarget = opts?.target ?? realAirgapTarget();

  const attempts: EgressAttempt[] = [];

  function makeGuard(seam: EgressSeam, original: (...a: unknown[]) => unknown): (...a: unknown[]) => unknown {
    return function guarded(this: unknown, ...args: unknown[]): unknown {
      const targetStr = describeTarget(seam, args);
      const { allowed, reason } = isAllowedTarget(targetStr, resolvedPolicy);
      const attempt: EgressAttempt = { seam, target: targetStr, at: nowFn(), blocked: !allowed, reason };
      attempts.push(attempt);
      if (onAttempt) {
        try {
          onAttempt(attempt);
        } catch {
          // A caller's observer must never be able to break the guard itself.
        }
      }
      if (!allowed) {
        throw new AirgapViolationError(seam, targetStr, reason);
      }
      return original.apply(this, args);
    };
  }

  const statuses: SeamStatus[] = [];
  const restores: Array<() => void> = [];

  for (const seam of resolvedPolicy.seams) {
    const { how, detail, restores: seamRestores } = neutralizeSeam(seam, target, makeGuard);
    statuses.push({ seam, neutralized: how !== "unavailable", how, detail });
    restores.push(...seamRestores);
  }

  // Only a session engaged against the REAL process runtime is registered as
  // in force for this process; one engaged against an injected test target
  // patches nothing globally and must never make `activeAirgapSessions()`
  // claim otherwise.
  const isRealRuntime = opts?.target === undefined;

  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    if (isRealRuntime) {
      const i = liveSessions.indexOf(session);
      if (i >= 0) liveSessions.splice(i, 1);
    }
    for (let i = restores.length - 1; i >= 0; i--) {
      try {
        restores[i]();
      } catch {
        // Best-effort: a failing individual restore must not prevent the
        // rest of the session's patches from being unwound.
      }
    }
  }

  function report(): AirgapReport {
    const sealed = statuses.every((s) => s.neutralized);
    return {
      sealed,
      seams: statuses.map((s) => ({ ...s })),
      unverifiableSeams: statuses.filter((s) => !s.neutralized).map((s) => s.seam),
      attempts: attempts.map((a) => ({ ...a })),
      policy: {
        allowLoopback: resolvedPolicy.allowLoopback,
        allowUnixSocket: resolvedPolicy.allowUnixSocket,
        allowHosts: [...resolvedPolicy.allowHosts],
        seams: [...resolvedPolicy.seams],
      },
    };
  }

  const session: AirgapSession = {
    report,
    attempts: () => attempts.map((a) => ({ ...a })),
    release,
  };
  if (isRealRuntime) liveSessions.push(session);
  return session;
}

export async function withAirgap<T>(opts: Parameters<typeof engageAirgap>[0], fn: (session: AirgapSession) => Promise<T>): Promise<T> {
  const session = engageAirgap(opts);
  try {
    return await fn(session);
  } finally {
    session.release();
  }
}

/**
 * A DRY probe: reports what WOULD be neutralized without leaving anything
 * engaged. Implemented as a real, synchronous engage-then-immediately-
 * release cycle (never a parallel "would it work" heuristic that could
 * drift from what `engageAirgap` actually does) — no attempt can be
 * observed or recorded in between because nothing yields between the patch
 * and the restore, so the net externally-visible effect on the target is
 * zero.
 */
export function probeAirgap(target?: AirgapTarget): AirgapReport {
  const session = engageAirgap({ target });
  const report = session.report();
  session.release();
  return report;
}
