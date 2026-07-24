/**
 * Phase 6 ecosystem exit demo: certify `swarm_run_verified` (the real MCP
 * tool in `./swarm-task-tool`) and hand the certified result across a real
 * MCP wire to an external client that independently re-verifies it.
 *
 * Everything here is composed from real modules — no mocks of the protocol,
 * no mocks of the engine:
 *
 *  - `./server` / `./client`     — the real MCP server, loopback transport
 *                                   pair, and client.
 *  - `./swarm-task-tool`         — the real `swarm_run_verified` tool.
 *  - `./cert-handoff`            — the real ed25519 STYX certificate handoff.
 *  - `../styx/certificate`       — the real ed25519 certificate authority.
 *  - `../../swarm-runtime/factory` (`createInlineSwarm`) plus
 *    `../../swarm-runtime/worker/executor` (`DemoExecutor`) — the real inline
 *    swarm engine, run with the SAME deterministic, non-LLM `DemoExecutor`
 *    used elsewhere in this repo for offline/CI runs. It is grounded, real
 *    code — every claim it emits cites an actual recorded "tool call" — but
 *    it is NOT a model, and this module never presents it as one; every
 *    transcript line that mentions it says "deterministic" explicitly.
 *
 * `certifiedSwarmTool` is the honesty-critical piece: it wraps an inner
 * `McpServerTool` (normally `swarm_run_verified`) and, ONLY for a result the
 * inner tool itself reports as `isError: false`, attaches a `CertifiedHandoff`
 * whose verdict/score are read straight out of the inner tool's own
 * `verifications`/`certificates` ledger — never a verdict the gate did not
 * itself emit. The `HandoffIssueInput.verdict` union has exactly two members
 * (`"accept" | "abstain"`), so anything short of the inner tool's own
 * `status === "verified"` (all-accept) is honestly reported as `"abstain"`,
 * never silently upgraded.
 */

import { McpServer, loopbackTransportPair, type McpServerTool } from "./server";
import { McpClient } from "./client";
import {
  createSwarmTaskTool,
  type SwarmSessionFactory,
  type SwarmSessionPort,
  type VerifiedSwarmResult,
} from "./swarm-task-tool";
import {
  issueHandoffCertificate,
  verifyHandoffAtBoundary,
  HANDOFF_VERSION,
  type CertifiedHandoff,
  type HandoffVerdict,
} from "./cert-handoff";
import { CertificateAuthority, generatePrivateKeyHex } from "../styx/certificate";
import { createInlineSwarm } from "../../swarm-runtime/factory";
import { DemoExecutor, type TaskExecutor } from "../../swarm-runtime/worker/executor";
import type { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// Locked report shape
// ---------------------------------------------------------------------------

export interface EcosystemDemoReport {
  toolListed: boolean;
  callOk: boolean;
  handoffPresent: boolean;
  verify: HandoffVerdict;
  /** Mutated resultText against the original certificate — must be ok:false. */
  tamperedResultVerify: HandoffVerdict;
  /** Corrupted signature hex against the original resultText — must be ok:false. */
  tamperedSignatureVerify: HandoffVerdict;
  /** Honest step-by-step log, plain text, no ANSI. */
  transcript: string[];
}

export interface EcosystemDemoOptions {
  factory?: SwarmSessionFactory;
  privateKeyHex?: string;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// certifiedSwarmTool — wraps an inner McpServerTool with a signed handoff
// ---------------------------------------------------------------------------

const KNOWN_STATUSES: ReadonlySet<VerifiedSwarmResult["status"]> = new Set([
  "verified",
  "partially-verified",
  "rejected",
  "failed",
  "timeout",
]);

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return String(err);
  } catch {
    return "unknown error";
  }
}

/**
 * Defensive structural check that `parsed` is shaped like a
 * {@link VerifiedSwarmResult} well enough to certify — never trusts the inner
 * tool's text blindly, since a future/misbehaving inner tool could emit
 * anything.
 */
function asVerifiedSwarmResult(parsed: unknown): VerifiedSwarmResult | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const r = parsed as Record<string, unknown>;
  if (typeof r.status !== "string" || !KNOWN_STATUSES.has(r.status as VerifiedSwarmResult["status"])) {
    return undefined;
  }
  if (typeof r.goalId !== "string") return undefined;
  if (typeof r.objective !== "string") return undefined;
  if (!Array.isArray(r.tasks)) return undefined;
  if (!Array.isArray(r.verifications)) return undefined;
  if (!Array.isArray(r.certificates)) return undefined;
  return r as unknown as VerifiedSwarmResult;
}

/**
 * Collects a real, non-fabricated `verifierVersions` list out of the inner
 * tool's own `certificates` ledger (verbatim `VerificationReport`-shaped
 * objects, per `./swarm-task-tool`): every distinct `checks[].name` the gate
 * actually ran, as `gate-check:<name>`. If the gate recorded zero checks
 * (e.g. zero tasks in the run), this is honestly empty rather than invented.
 */
function collectVerifierVersions(certificates: Array<Record<string, unknown>>): string[] {
  const names = new Set<string>();
  for (const cert of certificates) {
    const checks = cert.checks;
    if (!Array.isArray(checks)) continue;
    for (const check of checks) {
      if (check && typeof check === "object" && typeof (check as { name?: unknown }).name === "string") {
        names.add(`gate-check:${(check as { name: string }).name}`);
      }
    }
  }
  return [...names].sort();
}

/**
 * Real, non-fabricated aggregate score: the minimum score across every
 * recorded verification in this run. Minimum (not average) so the
 * certificate never overstates the run — it certifies no better than its
 * single worst-scored verification.
 */
function aggregateScore(verifications: VerifiedSwarmResult["verifications"]): number {
  const scores = verifications
    .map((v) => v.score)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (scores.length === 0) return 0;
  return Math.min(...scores);
}

/**
 * Wrap `inner` (normally `swarm_run_verified`) so its output is certified:
 * for any run the inner tool reports as `isError: false`, attach a
 * `CertifiedHandoff` whose verdict is `"accept"` iff the inner tool's own
 * `status === "verified"` (its all-accept case) and `"abstain"` otherwise —
 * the gate's own outcome, never upgraded. An inner `isError: true` result (an
 * infrastructure failure or a timeout) passes through completely
 * uncertified — no handoff is fabricated for a run that never produced a
 * trustworthy ledger. Malformed inner JSON is surfaced as an honest tool
 * error, never as a fabricated certificate.
 */
export function certifiedSwarmTool(
  inner: McpServerTool,
  authority: CertificateAuthority,
  now?: () => number,
): McpServerTool {
  return {
    name: "swarm_run_certified",
    description:
      `Runs '${inner.name}' to completion and attaches a signed STYX certificate ` +
      "(ed25519, HANDOFF_VERSION " +
      HANDOFF_VERSION +
      ") binding the exact result text to the verification gate's own verdict and score. " +
      "The certificate's verdict is 'accept' only when the inner tool's own result was fully " +
      "verified (all-accept); anything else is honestly certified as 'abstain'. An inner " +
      "tool-level error passes through completely uncertified.",
    inputSchema: inner.inputSchema,
    run: async (args) => {
      const res = await inner.run(args);
      if (res.isError) {
        // An infra failure (or timeout) never gets a certificate — pass it through as-is.
        return res;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(res.text);
      } catch (err) {
        return {
          text: `swarm_run_certified: inner tool result was not valid JSON — refusing to fabricate a certificate (${messageOf(err)})`,
          isError: true,
        };
      }

      const result = asVerifiedSwarmResult(parsed);
      if (!result) {
        return {
          text: "swarm_run_certified: inner tool result did not match the expected VerifiedSwarmResult shape — refusing to fabricate a certificate",
          isError: true,
        };
      }

      const verdict: "accept" | "abstain" = result.status === "verified" ? "accept" : "abstain";
      const score = aggregateScore(result.verifications);
      const verifierVersions = collectVerifierVersions(result.certificates);

      let handoff: CertifiedHandoff;
      try {
        handoff = await issueHandoffCertificate({
          authority,
          taskId: result.goalId.length > 0 ? result.goalId : "(no-goal-id)",
          objective: result.objective,
          resultText: res.text,
          verdict,
          score,
          verifierVersions,
          now,
        });
      } catch (err) {
        return {
          text: `swarm_run_certified: failed to issue certificate: ${messageOf(err)}`,
          isError: true,
        };
      }

      return {
        text: JSON.stringify({ ...result, handoff }),
        isError: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Default real-engine factory: the SAME `dispatchGoal` -> `manager.startGoal`
// adaptation `src/desktop/core/sidecar.ts`'s `realSwarmFactory` and
// `./swarm-task-tool`'s test suite already use, running the real inline swarm
// with the deterministic, non-LLM `DemoExecutor`.
// ---------------------------------------------------------------------------

function defaultRealFactory(): SwarmSessionFactory {
  const executor: TaskExecutor = new DemoExecutor();
  return async ({ poolSize, capabilities, maxAttempts }) => {
    const manager = await createInlineSwarm({ poolSize, capabilities, maxAttempts, executor });
    // `manager.on` is typed narrowly against the real engine's own event-name
    // union; the SwarmSessionPort surface only needs a generic string-keyed
    // `on`, exactly like `./swarm-task-tool`'s test-suite adapter — the
    // manager IS a real Node EventEmitter, so this cast only widens the event
    // name type, it does not change runtime behavior.
    const emitter = manager as unknown as EventEmitter;
    const port: SwarmSessionPort = {
      manager: {
        on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
        dispatchGoal: async (objective: string) => {
          const { goalId } = await manager.startGoal(objective);
          return { goalId };
        },
      },
      start: async () => {
        await manager.ensurePool();
      },
      stop: async () => {
        await manager.shutdown();
      },
    };
    return port;
  };
}

// ---------------------------------------------------------------------------
// Tamper helpers — deep-clone via JSON round-trip (the decoded handoff is
// already plain JSON data at this point), then corrupt exactly one thing.
// ---------------------------------------------------------------------------

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function tamperResultText(handoff: CertifiedHandoff): unknown {
  const clone = cloneJson(handoff);
  clone.resultText = `${clone.resultText}\n<tampered-by-ecosystem-demo>`;
  return clone;
}

function tamperSignature(handoff: CertifiedHandoff): unknown {
  const clone = cloneJson(handoff);
  const sig = clone.certificate.signature;
  // Flip the first hex character (wrap 'f' back to '0') — same length, same
  // structural shape, cryptographically invalid.
  const flipped = (sig[0] === "f" ? "0" : "f") + sig.slice(1);
  clone.certificate.signature = flipped;
  return clone;
}

// ---------------------------------------------------------------------------
// runEcosystemDemo — the whole stack, for real
// ---------------------------------------------------------------------------

export async function runEcosystemDemo(opts: EcosystemDemoOptions = {}): Promise<EcosystemDemoReport> {
  const transcript: string[] = [];
  const now = opts.now ?? Date.now;
  const privateKeyHex = opts.privateKeyHex ?? generatePrivateKeyHex();
  const authority = new CertificateAuthority(privateKeyHex);
  const factory = opts.factory ?? defaultRealFactory();

  transcript.push(
    "Executor: DemoExecutor — deterministic, non-LLM, no network. This is a real inline swarm run, not a model run.",
  );

  const innerTool = createSwarmTaskTool(factory, { now, defaultTimeoutMs: 20_000 });
  const certTool = certifiedSwarmTool(innerTool, authority, now);
  transcript.push(`Wrapped '${innerTool.name}' as '${certTool.name}' with certificate authority public key ${authority.publicKeyHex()}.`);

  const pair = loopbackTransportPair();
  const server = new McpServer(pair.server, { serverName: "hades-ecosystem-demo" });
  server.register(certTool);
  server.serve();
  transcript.push("Started real McpServer over an in-process loopback transport pair.");

  const client = new McpClient(pair.client, { timeoutMs: 20_000 });
  await client.initialize();
  transcript.push("Real McpClient completed the MCP initialize handshake.");

  const tools = await client.listTools();
  const toolListed = tools.some((t) => t.name === "swarm_run_certified");
  transcript.push(
    toolListed
      ? "tools/list confirms 'swarm_run_certified' is advertised by the server."
      : "tools/list did NOT advertise 'swarm_run_certified' — this is a failure.",
  );

  const objective = "Describe the module architecture";
  transcript.push(`tools/call 'swarm_run_certified' with objective: "${objective}"`);
  const callResult = await client.callTool("swarm_run_certified", {
    objective,
    poolSize: 2,
    capabilities: ["research", "code"],
  });
  const callOk = callResult.isError !== true;
  transcript.push(
    callOk
      ? "tools/call returned a non-error result."
      : `tools/call returned isError:true — ${callResult.content[0]?.text ?? "(no text)"}`,
  );

  let handoffPresent = false;
  let handoffRaw: unknown = undefined;
  let verify: HandoffVerdict = { ok: false, reasons: ["tools/call did not return a usable result"] };
  let tamperedResultVerify: HandoffVerdict = { ok: false, reasons: ["no handoff to tamper"] };
  let tamperedSignatureVerify: HandoffVerdict = { ok: false, reasons: ["no handoff to tamper"] };

  if (callOk) {
    const text = callResult.content[0]?.text ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      transcript.push(`Failed to decode tools/call result JSON: ${messageOf(err)}`);
      parsed = undefined;
    }

    if (parsed !== null && typeof parsed === "object" && "handoff" in (parsed as Record<string, unknown>)) {
      handoffRaw = (parsed as Record<string, unknown>).handoff;
      handoffPresent = handoffRaw !== null && typeof handoffRaw === "object";
    }

    transcript.push(
      handoffPresent
        ? "Decoded a CertifiedHandoff from the tools/call result."
        : "No CertifiedHandoff was present in the tools/call result.",
    );

    if (handoffPresent) {
      verify = await verifyHandoffAtBoundary(handoffRaw);
      transcript.push(
        verify.ok
          ? "verifyHandoffAtBoundary: OK — signature valid, hash bound correctly, structure sound."
          : `verifyHandoffAtBoundary: FAILED — ${verify.reasons.join("; ")}`,
      );

      const original = handoffRaw as CertifiedHandoff;

      tamperedResultVerify = await verifyHandoffAtBoundary(tamperResultText(original));
      transcript.push(
        tamperedResultVerify.ok
          ? "Tamper test (mutated resultText): UNEXPECTEDLY verified — this is a failure of the boundary check."
          : `Tamper test (mutated resultText): correctly rejected — ${tamperedResultVerify.reasons.join("; ")}`,
      );

      tamperedSignatureVerify = await verifyHandoffAtBoundary(tamperSignature(original));
      transcript.push(
        tamperedSignatureVerify.ok
          ? "Tamper test (corrupted signature): UNEXPECTEDLY verified — this is a failure of the boundary check."
          : `Tamper test (corrupted signature): correctly rejected — ${tamperedSignatureVerify.reasons.join("; ")}`,
      );
    }
  }

  client.close();
  transcript.push("Closed the McpClient; ecosystem demo run complete.");

  return {
    toolListed,
    callOk,
    handoffPresent,
    verify,
    tamperedResultVerify,
    tamperedSignatureVerify,
    transcript,
  };
}
