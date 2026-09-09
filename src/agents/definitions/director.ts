/**
 * The Director team: Planner, Operator, Cinematographer, Reviewer.
 *
 * Orchestration note: this module deliberately does NOT use `src/agents/orchestrator.ts`. That
 * module builds agents with `resolveAgentTools` + `toOpenAITool` and never calls `wrapTools`, so
 * security, governance, approvals and audit are all dropped for orchestrated runs — unacceptable
 * for a team that drives someone's Mac. Instead the stages are composed explicitly here and each
 * agent stage is executed through an injected `DirectorAgentRunner`, whose default builds a real
 * harness (`createStandardHarness` → `createCustomHarness`), which does apply plugins.
 *
 * The Operator is a hand-written observe → decide → act loop rather than an agent turn budget,
 * because it needs a step cap, stall detection and a hard stop that hold even when the model
 * keeps proposing plausible next actions.
 */

import { z } from "zod";
import { defineAgent } from "./builder";
import type { AgentDefinition } from "./types";
import type { AgentContext } from "../types";
import {
	buildStoryboard,
	validateStoryboard,
	StoryboardInvalidError,
} from "../tools/cap/storyboard";
import { DEFAULT_EDITORIAL_LIMITS, BeatKindSchema } from "../tools/cap/types";
import type { Beat, EditorialLimits, Storyboard } from "../tools/cap/types";
import type { ActToolResult, ObservationSummary } from "../tools/cap/tools";
import { observationFingerprint } from "../tools/cap/tools";
import type { InputAction } from "../tools/cap/types";
import {
	type ExportQaDeps,
	type ExportQaInput,
	type QaReport,
	runExportQa,
	toReviewVerdict,
} from "../qa/review";
import { QaVerdictError } from "../qa/model";
import { AgentError } from "../errors/index";

/** OpenAI's computer-use model. Override per deployment via `createDirectorTeam`. */
export const OPENAI_COMPUTER_USE_MODEL = "computer-use-preview";

// ── Shot plan ─────────────────────────────────────────────────────────────────

export const ShotPlanStepSchema = z.object({
	intent: z.string().min(1),
	expectedBeat: BeatKindSchema,
	successCriteria: z.string().min(1),
});

export const ShotPlanSchema = z.object({
	title: z.string().min(1),
	summary: z.string().min(1),
	targetDurationMs: z.number().int().min(1_000).max(DEFAULT_EDITORIAL_LIMITS.maxTotalMs),
	application: z.string().min(1).describe("Bundle identifier the demo is shot in"),
	steps: z.array(ShotPlanStepSchema).min(1).max(12),
});
export type ShotPlan = z.infer<typeof ShotPlanSchema>;

// ── Team ──────────────────────────────────────────────────────────────────────

export interface DirectorTeamOptions {
	/** Tool names from a `createCapToolPack` result, so a namespaced pack wires up correctly. */
	toolNames: {
		observe: string;
		listWindows: string;
		act: string;
		recordingStart: string;
		recordingStop: string;
		applyStoryboard: string;
		exportVideo: string;
	};
	limits?: EditorialLimits;
	plannerModel?: string;
	operatorModel?: string;
	cinematographerModel?: string;
	reviewerModel?: string;
}

export interface DirectorTeam {
	planner: AgentDefinition;
	operator: AgentDefinition;
	cinematographer: AgentDefinition;
	reviewer: AgentDefinition;
	all: AgentDefinition[];
}

export function createDirectorTeam(options: DirectorTeamOptions): DirectorTeam {
	const limits = options.limits ?? DEFAULT_EDITORIAL_LIMITS;
	const t = options.toolNames;

	const planner = defineAgent("director-planner")
		.role("reasoning")
		.description("Turns a feature brief into a shot plan the Operator can execute.")
		.instructions(
			[
				"You plan product demos that will be recorded on a real Mac by another agent.",
				"Produce a shot plan: a title, a one-sentence summary, the bundle identifier of the application to demo, a target duration, and an ordered list of steps.",
				`The finished video must fit ${limits.maxTotalMs}ms with at most ${limits.maxShots} shots, so plan no more beats than can be shown in that time.`,
				"Every step states one intent, the kind of beat it produces (action, reveal, typing, transition, idle) and an observable success criterion.",
				"Never plan steps that need credentials, payment details, or destructive changes to the user's machine.",
			].join("\n")
		)
		.model(options.plannerModel ?? "gpt-4o")
		.tools([t.listWindows])
		.autonomy("full")
		.boundaries({
			blockedTools: [t.act, t.recordingStart, t.recordingStop, t.exportVideo],
			refuseTopics: ["credentials", "payment details", "deleting user data"],
			deferWhen: ["Defer to the human when the demo requires signing in or paying"],
		})
		.constraints({ noHandoffs: true })
		.build();

	const operator = defineAgent("director-operator")
		.role("tooling")
		.description("Drives the Mac: observes the screen, decides one action, acts, repeats.")
		.instructions(
			[
				"You operate a real Mac belonging to a human who is watching you.",
				"Work one step at a time: read the latest observation, choose exactly one input action, and label the beat it produces.",
				"Prefer element targets (role/title/identifier) over raw coordinates — they survive layout changes.",
				"If two consecutive observations are identical, the last action did nothing: change approach instead of repeating it.",
				"Stop and report when the plan's success criteria are met, or when you cannot proceed without the human.",
				"Never type secrets, never act on a window the observation reports as redacted, and never leave the applications named in the plan.",
			].join("\n")
		)
		.model(options.operatorModel ?? OPENAI_COMPUTER_USE_MODEL)
		.tools([t.observe, t.listWindows, t.act, t.recordingStart, t.recordingStop])
		.autonomy("supervised")
		.boundaries({
			blockedTools: [t.applyStoryboard, t.exportVideo],
			refuseTopics: ["passwords", "credentials", "payment details"],
			deferWhen: [
				"Defer to the human when a step needs a credential, a payment, or a destructive change",
			],
		})
		.constraints({
			requireApproval: [t.act, t.recordingStart],
			irreversibleTools: [t.act],
			noHandoffs: true,
		})
		.escalation({
			escalateTo: "director-reviewer",
			when: [
				"When the same screen repeats after two actions",
				"When a target cannot be found twice in a row",
				"When an action needs a scope the session lease does not grant",
			],
		})
		.build();

	const cinematographer = defineAgent("director-cinematographer")
		.role("optimization")
		.description("Compiles the beat log into a storyboard that honours the editorial limits.")
		.instructions(
			[
				"You cut raw screen footage into a short product demo.",
				`Hard limits: ${limits.maxTotalMs}ms total, at most ${limits.maxShots} shots, no shot shorter than ${limits.minShotMs}ms.`,
				"A camera cut must be a content cut: every shot after the first aims at a logged non-idle beat that falls inside its own span.",
				"Use one motion system for the whole piece — either cuts or dollies, never both.",
				"Aim at the beat's landmark rather than the window centre, and keep the synthesized cursor on.",
			].join("\n")
		)
		.model(options.cinematographerModel ?? "gpt-4o")
		.tools([t.applyStoryboard])
		.autonomy("supervised")
		.boundaries({ blockedTools: [t.act, t.recordingStart, t.recordingStop] })
		.constraints({ noHandoffs: true })
		.build();

	const reviewer = defineAgent("director-reviewer")
		.role("monitoring")
		.description("Frame-QA on the export; decides accept, reshoot or re-export.")
		.instructions(
			[
				"You review a rendered demo before it reaches a human.",
				"Check that the export duration matches the storyboard, that the frame rate matches the measured capture rate (forcing a higher rate judders), and that every shot shows the content its beat promised.",
				"Return exactly one verdict: accept, reshoot (the footage is unusable), or re_export (the footage is fine but the cut or render is wrong).",
				"Say what specifically is wrong and which shot it is in; a verdict without a located defect is not actionable.",
			].join("\n")
		)
		.model(options.reviewerModel ?? "gpt-4o")
		.tools([t.observe, t.exportVideo])
		.autonomy("supervised")
		.boundaries({ blockedTools: [t.act, t.recordingStart] })
		.constraints({ noHandoffs: true })
		.build();

	return {
		planner,
		operator,
		cinematographer,
		reviewer,
		all: [planner, operator, cinematographer, reviewer],
	};
}

// ── Agent stage runner ────────────────────────────────────────────────────────

export interface DirectorAgentRunner {
	(agent: AgentDefinition, message: string, ctx?: AgentContext): Promise<string>;
}

/**
 * Default stage runner. Goes through the real harness so plugins (security, governance,
 * approvals, observability) actually wrap the tools.
 */
export function createHarnessAgentRunner(): DirectorAgentRunner {
	return async (agent, message, ctx) => {
		const { createStandardHarness } = await import("../presets/index");
		const harness = createStandardHarness(agent);
		const result = await harness.run({
			messages: [{ role: "user", content: message }],
			context: ctx,
		});
		return result.finalOutput;
	};
}

// ── Operator loop ─────────────────────────────────────────────────────────────

export type OperatorDecision =
	| { type: "act"; action: InputAction; beatLabel?: string; rationale?: string }
	| { type: "done"; summary: string }
	| { type: "give_up"; reason: string };

export interface OperatorStep {
	index: number;
	atUnixMs: number;
	observation: ObservationSummary;
	fingerprint: string;
	decision: OperatorDecision;
	result?: ActToolResult;
	error?: string;
}

export type OperatorStopReason =
	| "completed"
	| "gave_up"
	| "max_steps"
	| "stalled"
	| "hard_stop"
	| "aborted"
	| "kill_switch"
	| "repeated_errors";

export interface OperatorLoopContext {
	goal: string;
	stepIndex: number;
	observation: ObservationSummary;
	history: OperatorStep[];
}

export interface OperatorLoopOptions {
	sessionId: string;
	goal: string;
	observe: (stepIndex: number) => Promise<ObservationSummary>;
	decide: (ctx: OperatorLoopContext) => Promise<OperatorDecision>;
	act: (action: InputAction, beatLabel?: string) => Promise<ActToolResult>;
	/** Hard ceiling on observe→act cycles. Default 24. */
	maxSteps?: number;
	/** Consecutive identical observations tolerated before the loop calls it a stall. Default 3. */
	stallLimit?: number;
	/** Wall-clock ceiling for the whole loop. Default 5 minutes. */
	hardStopMs?: number;
	/** Consecutive action failures tolerated. Default 3. */
	errorLimit?: number;
	isKillSwitchEngaged?: () => boolean;
	signal?: AbortSignal;
	now?: () => number;
}

export interface OperatorLoopResult {
	sessionId: string;
	goal: string;
	steps: OperatorStep[];
	stoppedBy: OperatorStopReason;
	summary: string;
	beats: Beat[];
}

export async function runOperatorLoop(
	options: OperatorLoopOptions
): Promise<OperatorLoopResult> {
	const {
		sessionId,
		goal,
		observe,
		decide,
		act,
		maxSteps = 24,
		stallLimit = 3,
		hardStopMs = 5 * 60_000,
		errorLimit = 3,
		isKillSwitchEngaged,
		signal,
	} = options;
	const now = options.now ?? (() => Date.now());

	const steps: OperatorStep[] = [];
	const beats: Beat[] = [];
	const startedAt = now();

	let stoppedBy: OperatorStopReason = "max_steps";
	let summary = `Reached the ${maxSteps}-step cap without finishing.`;
	let lastFingerprint: string | null = null;
	let identicalRepeats = 0;
	let consecutiveErrors = 0;

	for (let index = 0; index < maxSteps; index++) {
		if (signal?.aborted) {
			stoppedBy = "aborted";
			summary = "The run was cancelled.";
			break;
		}
		if (isKillSwitchEngaged?.()) {
			stoppedBy = "kill_switch";
			summary = "The user engaged the kill switch.";
			break;
		}
		if (now() - startedAt >= hardStopMs) {
			stoppedBy = "hard_stop";
			summary = `Hit the ${hardStopMs}ms hard stop.`;
			break;
		}

		const observation = await observe(index);
		const fingerprint = observationFingerprint(observation);
		identicalRepeats = fingerprint === lastFingerprint ? identicalRepeats + 1 : 0;
		lastFingerprint = fingerprint;

		if (identicalRepeats >= stallLimit) {
			stoppedBy = "stalled";
			summary = `The screen did not change across ${identicalRepeats + 1} consecutive observations.`;
			break;
		}

		const decision = await decide({ goal, stepIndex: index, observation, history: steps });
		const step: OperatorStep = {
			index,
			atUnixMs: now(),
			observation,
			fingerprint,
			decision,
		};

		if (decision.type === "done") {
			steps.push(step);
			stoppedBy = "completed";
			summary = decision.summary;
			break;
		}

		if (decision.type === "give_up") {
			steps.push(step);
			stoppedBy = "gave_up";
			summary = decision.reason;
			break;
		}

		try {
			const result = await act(decision.action, decision.beatLabel);
			step.result = result;
			if (result.beat) beats.push(result.beat);
			consecutiveErrors = 0;
		} catch (error) {
			step.error = error instanceof Error ? error.message : String(error);
			consecutiveErrors += 1;
		}

		steps.push(step);

		if (consecutiveErrors >= errorLimit) {
			stoppedBy = "repeated_errors";
			summary = `Aborted after ${consecutiveErrors} consecutive action failures: ${step.error}`;
			break;
		}
	}

	return { sessionId, goal, steps, stoppedBy, summary, beats };
}

// ── Cinematographer stage ─────────────────────────────────────────────────────

export interface CinematographyInput {
	projectPath: string;
	sourceFps: number;
	durationMs: number;
	beats: Beat[];
	limits?: EditorialLimits;
}

/**
 * Compile the beat log into a storyboard and prove it against the editorial limits before it
 * reaches the runner. Retries once with a tighter tail shot, then fails loudly.
 */
export function composeStoryboard(input: CinematographyInput): Storyboard {
	const limits = input.limits ?? DEFAULT_EDITORIAL_LIMITS;
	const first = buildStoryboard({ ...input, limits });
	const issues = validateStoryboard(first, { limits, beats: input.beats });
	if (issues.length === 0) return first;

	const tightened = buildStoryboard({
		...input,
		limits,
		tailShotMs: limits.minShotMs,
	});
	const remaining = validateStoryboard(tightened, { limits, beats: input.beats });
	if (remaining.length > 0) throw new StoryboardInvalidError(remaining);
	return tightened;
}

// ── Reviewer loop ─────────────────────────────────────────────────────────────

export const ReviewVerdictSchema = z.object({
	verdict: z.enum(["accept", "reshoot", "re_export"]),
	notes: z.string().min(1),
	shotId: z.string().nullish(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export interface IndeterminatePass {
	pass: number;
	reason: string;
	code: string;
}

export interface ReviewLoopOptions {
	review: (pass: number) => Promise<ReviewVerdict>;
	onReshoot?: (verdict: ReviewVerdict, pass: number) => Promise<void>;
	onReExport?: (verdict: ReviewVerdict, pass: number) => Promise<void>;
	/**
	 * A pass that could not produce a trustworthy verdict — a malformed or low-confidence QA
	 * response. It is never an accept, so the loop records it and looks again.
	 */
	onIndeterminate?: (error: Error, pass: number) => Promise<void>;
	/** Passes before the loop gives up and hands the defect to the human. Default 3. */
	maxPasses?: number;
}

export interface ReviewLoopResult {
	passes: ReviewVerdict[];
	accepted: boolean;
	stoppedBy: "accepted" | "max_passes" | "qa_failed";
	/** Present only when a pass failed to produce a verdict at all. */
	indeterminate?: IndeterminatePass[];
}

/**
 * Explicit accept / reshoot / re-export loop. Written out rather than delegated to
 * `runIterative` so the regrade actions run under the same governed tool path as the shoot.
 *
 * A review that throws is a QA pass that did not happen: it is recorded, never converted into an
 * accept, and if no pass in the budget produced a verdict the loop stops at `qa_failed` and the
 * export goes to a human.
 */
export async function runReviewLoop(
	options: ReviewLoopOptions
): Promise<ReviewLoopResult> {
	const { review, onReshoot, onReExport, onIndeterminate, maxPasses = 3 } = options;
	const passes: ReviewVerdict[] = [];
	const indeterminate: IndeterminatePass[] = [];

	const result = (
		accepted: boolean,
		stoppedBy: ReviewLoopResult["stoppedBy"]
	): ReviewLoopResult => ({
		passes,
		accepted,
		stoppedBy,
		indeterminate: indeterminate.length > 0 ? indeterminate : undefined,
	});

	for (let pass = 0; pass < maxPasses; pass++) {
		let verdict: ReviewVerdict;
		try {
			verdict = await review(pass);
		} catch (error) {
			const failure = error instanceof Error ? error : new Error(String(error));
			indeterminate.push({
				pass,
				reason: failure.message,
				code: failure instanceof AgentError ? failure.code : "QA_REVIEW_THREW",
			});
			await onIndeterminate?.(failure, pass);
			continue;
		}
		passes.push(verdict);

		if (verdict.verdict === "accept") {
			return result(true, "accepted");
		}
		if (verdict.verdict === "reshoot") {
			await onReshoot?.(verdict, pass);
		} else {
			await onReExport?.(verdict, pass);
		}
	}

	return result(false, passes.length === 0 ? "qa_failed" : "max_passes");
}

// ── Frame QA wiring ───────────────────────────────────────────────────────────

export interface FrameQaReviewOptions {
	/**
	 * The export to look at. A function is re-evaluated per pass, so pass 1 reviews the file the
	 * re-export actually produced rather than the one that failed.
	 */
	input: ExportQaInput | ((pass: number) => ExportQaInput | Promise<ExportQaInput>);
	deps: ExportQaDeps;
	onReport?: (report: QaReport) => void | Promise<void>;
}

/**
 * The real review: extract beat frames from the export, look at them, and return the verdict the
 * loop already knows how to route. Both seams (ffmpeg and the model) stay injected.
 */
export function createFrameQaReview(
	options: FrameQaReviewOptions
): (pass: number) => Promise<ReviewVerdict> {
	return async (pass) => {
		const input =
			typeof options.input === "function" ? await options.input(pass) : options.input;
		const report = await runExportQa({ ...input, pass }, options.deps);
		await options.onReport?.(report);
		return ReviewVerdictSchema.parse(toReviewVerdict(report));
	};
}

export interface FrameQaReviewLoopOptions
	extends FrameQaReviewOptions,
		Omit<ReviewLoopOptions, "review"> {}

export function runFrameQaReviewLoop(
	options: FrameQaReviewLoopOptions
): Promise<ReviewLoopResult> {
	const { input, deps, onReport, ...loop } = options;
	return runReviewLoop({ ...loop, review: createFrameQaReview({ input, deps, onReport }) });
}

/** True when a pass failed because the QA itself could not be trusted, not because the cut was wrong. */
export function isQaUnavailable(error: unknown): error is QaVerdictError {
	return error instanceof QaVerdictError;
}
