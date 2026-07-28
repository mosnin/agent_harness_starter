/**
 * The bridge that carries STYX verification into the PRODUCT path.
 *
 * ## Why this file exists
 *
 * The T1-reference verifier (`./reference-verifier.ts`) demonstrably works:
 * in `../bench/showdown.ts` it turned a live run from "4 silent-wrong / 0
 * declined" into "0 silent-wrong / 4 declined" while a model that actually
 * solves the tasks still scored 4/4 verified. But it only ran inside the
 * benchmark. Everything a user actually runs — a swarm goal through
 * `SwarmManager`, a gateway request through the verified swarm engine —
 * passes `src/swarm-runtime/verification/gate.ts`'s `VerificationGate`, whose
 * six checks all ask whether an answer is properly EVIDENCED and none of
 * which ask whether it is RIGHT. The moat existed and did not reach the
 * product. This module is the connector.
 *
 * ## Which way the dependency points, and why
 *
 * `swarm-runtime`'s LIBRARY modules stay free of `src/hades/**`, so the
 * *interface* (`ExternalVerifier`) is declared down there and the *adapter*
 * lives here, in the layer that already depends on both. Same inversion
 * `build-swarm.ts` uses for `decorateProvider`.
 *
 * That is a rule about library modules, not a claim that no file under
 * `src/swarm-runtime/` may import hades: `distributed/` already does so in
 * seven non-test modules (`lease-ledger.ts`, `cluster-node.ts`,
 * `membership.ts`, `cluster-chaos.ts`, `federation-link.ts`,
 * `federation-router.ts`, `cluster-autoscaler.ts`), and
 * `swarm-runtime/index.ts` re-exports them. So COMPOSITION ROOTS wire the
 * bridge in directly — `src/swarm-runtime/cli.ts` (`run` and `serve`) does
 * exactly that, alongside the gateway's `engine-select.ts` and the MCP swarm
 * session factory. Leaving the CLI — product surface #1 — unable to catch a
 * wrong answer would have been a choice, not an architectural necessity.
 *
 * ## What it actually checks (and what it deliberately does not)
 *
 * **One verifier in this bridge can refute anything: T1-reference recompute.**
 * That is the whole of the correctness coverage here, and it only fires on a
 * request carrying a `SPEC:` reference. Everything else registered in the
 * `procedure` domain abstains by construction (see the `declaredSteps`
 * paragraph below), and the tool / memory / message domain verifiers are never
 * consulted at all because this bridge only ever builds a `procedure` subject.
 * "STYX verification reaches the product" is true; "the STYX verifier stack
 * grades every swarm result" is not, and must not be claimed.
 *
 * The `TrustSubject` this builds agrees with `showdown.ts`'s
 * `referenceSubject` on the three fields a T1-reference vote is computed
 * from — `domain`, `input` (the request), `output` (the exact answer text) —
 * so the benchmark lane and the production gate can never reach different
 * verdicts about the same answer. That agreement is the entire point of
 * reusing the shape rather than inventing a second one.
 *
 * ## The subject is the GOAL's answer, never an intermediate result
 *
 * A T1-reference vote answers "is this the objective's correct answer?", so it
 * is only meaningful about a result that is OFFERED as that answer. A swarm
 * decomposes one objective into many subtasks and the shipped
 * `DeterministicPlanner` copies the objective — `SPEC:` line and all — into
 * every one of them (`Investigate the objective from the "code" angle:
 * <objective>`). Those subtasks correctly return prose.
 *
 * Judging them against the recomputed reference refutes correct work, and
 * because a refutation is a hard veto in the gate, it fails the whole goal.
 * That was a real, shipped regression: a competent model — prose on the
 * fan-out subtasks, the exact reference answer on the synthesis task — could
 * not complete a single SPEC-bearing goal on the gateway swarm path, while
 * the same run with this bridge removed returned the right answer and
 * certified it. Declining a correct run is not "declining beats lying"; it is
 * the same failure wearing the opposite sign.
 *
 * So the bridge votes only when the caller states the result is the goal's
 * answer (`input.isGoalAnswer === true`) and otherwise ABSTAINS with an
 * explicit reason. The manager derives that flag from the same predicate it
 * uses to pick the goal's synthesis, so the thing being graded is exactly the
 * thing the run returns. Absent the flag — a host calling `gate.verify`
 * directly — the bridge abstains too: silence about a result nobody claimed
 * was an answer is correct, and a false veto is not recoverable.
 *
 * `evidence` and `trace` are derived from the worker's claims and tool trace
 * as audit context. What they do NOT contain is `evidence.declaredSteps`,
 * and that omission is deliberate: `verify.procedure-run`
 * (`./emission-adapters.ts`) claims every `procedure` subject and checks a
 * trace against a DECLARED step manifest. A swarm worker never declares one.
 * Synthesizing a manifest here so that verifier had something to vote on
 * would be manufacturing a structural signal nobody produced — and since a
 * failing vote is a hard veto in the gate, it would reject correct answers
 * for failing a check about a record the swarm does not keep. Without
 * `declaredSteps` that verifier abstains with its own documented reason code,
 * which is the honest outcome — and is why T1-reference is the only voter in
 * this build that can actually refute a swarm result.
 *
 * ## Fail / pass / abstain
 *
 * The bridge reports what the registry ACTUALLY voted; it does not threshold
 * a fused score into a boolean. A score is a calibrated aggregate, not a
 * proof, and turning "0.42" into "wrong" would hand the gate's hard veto a
 * signal that never claimed that much. So: any contributing verdict that
 * failed ⇒ fail; no contributing verdict at all ⇒ abstain; otherwise pass.
 *
 * @module hades/trust/swarm-bridge
 */

import type {
  ExternalVerification,
  ExternalVerifier,
  ExternalVerifierInput,
} from "../../swarm-runtime/verification/gate";

import { actionVerifiers } from "./action-adapters";
import { emissionVerifiers } from "./emission-adapters";
import { referenceRecomputeVerifier } from "./reference-verifier";
import { VerifierRegistry, type TrustSubject, type TrustTraceStep, type UniversalVerdict } from "./registry";

/**
 * The `procedure`-domain verifier set, assembled from the SAME factories
 * `openTrustStack()` registers from — filtered by domain, never enumerated by
 * hand, so the two cannot drift apart.
 *
 * Deliberately NOT `openTrustStack()`: that mints/persists an ed25519 signing
 * key, opens a hash-chained budget file and reads calibration from disk. A
 * per-result correctness check needs none of that, and a verification hook
 * that writes to the filesystem the first time a worker reports would be a
 * side effect nobody asked for.
 */
export function procedureTrustRegistry(): VerifierRegistry {
  const registry = new VerifierRegistry();
  for (const v of [...actionVerifiers(), ...emissionVerifiers()]) {
    if (v.domain === "procedure") registry.register(v);
  }
  registry.register(referenceRecomputeVerifier("procedure"));
  return registry;
}

/**
 * Render a worker's `output` (typed `unknown`) as the exact text a verifier
 * compares and a certificate would bind.
 *
 * Strings pass through verbatim — the common case, and what `showdown.ts`
 * feeds the same verifier, so the two agree. Primitives stringify naturally
 * (`42`, not `"42"`), because a reference spec's recomputed truth is bare
 * text and quoting it would fail a correct answer. Anything structural is
 * JSON-encoded so the text is at least deterministic; such an output will
 * simply not match a scalar reference, which is the truthful result — the
 * task asked for the exact result and got an object.
 */
export function workerOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (typeof output === "number" || typeof output === "boolean" || typeof output === "bigint") {
    return String(output);
  }
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

/**
 * The request text a verdict about this result must be judged against.
 *
 * The GOAL's objective wins over the subtask description, because the
 * objective is where a `SPEC:` reference is put and a planner is free to
 * paraphrase, truncate or drop it when writing a subtask. Falling back to the
 * task description keeps a caller that only has the request (a direct
 * `gate.verify` consumer, the unit tests) working. Absent both it is `""` —
 * which carries no `SPEC:` line, so every reference-based verifier abstains
 * and the bridge casts no vote. That is the correct degradation: without the
 * request there is nothing to recompute against, and guessing would be worse
 * than silence.
 */
export function referenceRequest(input: ExternalVerifierInput): string {
  return input.objective ?? input.taskDescription ?? "";
}

/**
 * Build the `TrustSubject` for one swarm worker result.
 *
 * `input` is {@link referenceRequest} — the request this result is claiming to
 * answer. Note this function does NOT itself decide whether the result should
 * be judged at all; that is {@link createSwarmTrustBridge}'s
 * `isGoalAnswer` guard, kept separate so the subject shape stays a faithful
 * description of the result and the abstention stays an explicit, reasoned
 * decision rather than a blanked-out field.
 */
export function swarmResultSubject(input: ExternalVerifierInput): TrustSubject {
  const toolTrace = Array.isArray(input.toolTrace) ? input.toolTrace : [];
  const claims = Array.isArray(input.claims) ? input.claims : [];
  const trace: TrustTraceStep[] = toolTrace.map((t, i) => ({
    seq: i + 1,
    kind: t.tool,
    detail: t.output,
  }));

  return {
    domain: "procedure",
    subjectId: input.taskId,
    taskId: input.taskId,
    input: referenceRequest(input),
    output: workerOutputText(input.output),
    // Audit context only — see the module docs on why `declaredSteps` is
    // absent. `evidence` is never itself proof of anything to any verifier.
    evidence: Object.freeze({
      workerId: input.workerId,
      claims: claims.map((c) => ({
        statement: c.statement,
        evidence: [...c.evidence],
        confidence: c.confidence,
      })),
      toolTrace: toolTrace.map((t) => ({ tool: t.tool, ok: t.ok, output: t.output })),
    }),
    trace,
  };
}

export interface SwarmTrustBridgeOptions {
  /**
   * Verifier set to consult. Defaults to {@link procedureTrustRegistry}.
   * Injectable so tests (and a surface that already holds a `TrustStack`) run
   * the real code path without a key, a data directory, or a network call.
   */
  registry?: VerifierRegistry;
  /** Per-verifier timeout handed to the registry. Its default is 5s. */
  timeoutMs?: number;
}

/** One verdict rendered as reason lines: `id@tier:code`, then its own text. */
function verdictReasons(v: UniversalVerdict): string[] {
  const head = `${v.verifierId}@${v.tier}`;
  return v.reasons.length > 0 ? v.reasons.map((r) => `${head}:${r}`) : [head];
}

/**
 * Reason code for the abstention that keeps this bridge from grading work
 * product. Exported because a test asserting "correct intermediate results are
 * left alone" should assert the documented code, not a prose fragment.
 */
export const NOT_GOAL_ANSWER_REASON = "abstain:not-the-goal-answer";

/**
 * Build the `ExternalVerifier` the swarm's `VerificationGate` accepts.
 *
 * Never throws and never rejects: `VerifierRegistry.verify` already isolates
 * every verifier behind a timeout and a try/catch, and the gate treats a
 * thrown hook as an outage anyway. The three outcomes are exactly the three
 * the gate distinguishes:
 *
 *  - **abstain** — this result is not the goal's answer (`isGoalAnswer` not
 *    `true`), or nothing could judge the subject (no `SPEC:` reference in the
 *    request, no declared step manifest). The gate must behave as if no hook
 *    were configured, so the score does not move.
 *  - **fail** — a verifier that claimed this subject voted against it. The
 *    gate turns this into a hard veto; see its `verify()` docs for why a
 *    proof of wrongness must not be weighted.
 *  - **pass** — every contributing verifier voted for it. Worth a positive
 *    contribution, never a rescue of an ungrounded result.
 *
 * The `isGoalAnswer` guard is checked FIRST, before the registry runs at all:
 * a T1-reference verdict about an intermediate result is not merely unhelpful,
 * it is wrong, and the cheapest way to never emit one is to never compute it.
 * See the module docs for the regression this closes.
 */
export function createSwarmTrustBridge(opts: SwarmTrustBridgeOptions = {}): ExternalVerifier {
  const registry = opts.registry ?? procedureTrustRegistry();
  const timeoutMs = opts.timeoutMs;

  return {
    async verify(input: ExternalVerifierInput): Promise<ExternalVerification> {
      if (input.isGoalAnswer !== true) {
        return {
          passed: false,
          abstained: true,
          tier: "none",
          reasons: [
            NOT_GOAL_ANSWER_REASON,
            input.isGoalAnswer === false
              ? "this result is intermediate work product, not the run's answer to the objective; " +
                "the objective's expected answer says nothing about whether it is good work"
              : "the caller did not state that this result is the run's answer to the objective, " +
                "so there is nothing it can be checked against (pass isGoalAnswer: true to have it graded)",
          ],
        };
      }

      const subject = swarmResultSubject(input);
      const fused = await registry.verify(subject, timeoutMs === undefined ? undefined : { timeoutMs });
      const contributing = fused.verdicts.filter((v) => !v.abstained);

      // `degraded` is carried through verbatim rather than smoothed over: a
      // reader of the gate report is entitled to know the verdict came from a
      // lone voter with no one to disagree with it.
      const degraded = fused.degraded ? [`degraded:${fused.degradedReason ?? "unknown"}`] : [];

      if (contributing.length === 0) {
        const abstainers = fused.verdicts.flatMap(verdictReasons);
        return {
          passed: false,
          abstained: true,
          tier: fused.tier,
          reasons: [
            "abstain:no-verifier-could-judge",
            ...(fused.verdicts.length === 0 ? ["no verifier claimed this subject"] : abstainers),
          ],
        };
      }

      const refuted = contributing.filter((v) => !v.passed);
      if (refuted.length > 0) {
        return {
          passed: false,
          abstained: false,
          tier: fused.tier,
          reasons: ["refuted", ...refuted.flatMap(verdictReasons), ...degraded],
        };
      }

      return {
        passed: true,
        abstained: false,
        tier: fused.tier,
        reasons: ["verified", ...contributing.flatMap(verdictReasons), ...degraded],
      };
    },
  };
}
