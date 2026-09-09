/**
 * Replay execution and drift classification.
 *
 * Each step is re-resolved against a live observation and then performed, and the outcome is one
 * of three things that must never be collapsed into each other:
 *
 *   matched  — resolved exactly as the shoot did.
 *   drifted  — resolved, but the element moved, was renamed, or came back by a weaker criterion.
 *              The flow still works; the documentation of it is now wrong.
 *   broken   — could not be resolved at all. The flow no longer exists.
 *
 * Collapsing drift into breakage makes the tool cry wolf and it gets muted; collapsing it into
 * success makes it useless, because a screenshot of a button that has been renamed is exactly the
 * rot this is built to find.
 *
 * The pack is driven through its own `execute`, so `authorizeDesktopCommand` runs on every command
 * — the orchestrator never applies plugins, and this module is not allowed to be the hole.
 */

import type { CapToolPack } from "../tools/cap/tools";
import type { ToolContext } from "../tools/types";
import type {
	Beat,
	InputAction,
	ObserveRequest,
	Rect,
	StartRecordingRequest,
	Target,
} from "../tools/cap/types";
import { FALLBACK_FLOOR, MATCH_CRITERIA, criterionStrength } from "./plan";
import type {
	ElementQuery,
	MatchCriterion,
	ReplayPlan,
	ReplayPlanStep,
	ReplayPlanTarget,
	ResolvedElement,
	TargetSlot,
} from "./plan";

export type StepStatus = "matched" | "drifted" | "broken";

export type DriftReason =
	| "weaker_match"
	| "renamed"
	| "reidentified"
	| "role_changed"
	| "moved"
	| "resized"
	| "ambiguity_resolved_by_order"
	| "focus_lost";

export type BreakageReason =
	| "unresolved"
	| "ambiguous"
	| "element_disabled"
	| "element_list_truncated"
	| "observation_failed"
	| "action_failed";

export interface BoundsDelta {
	dx: number;
	dy: number;
	dWidth: number;
	dHeight: number;
}

export interface TargetResolution {
	slot: TargetSlot;
	label: string;
	query: ElementQuery;
	status: StepStatus;
	baselineCriterion: MatchCriterion;
	criterion: MatchCriterion | null;
	baseline: ResolvedElement;
	resolved: ResolvedElement | null;
	drift: DriftReason[];
	breakage: BreakageReason | null;
	boundsDelta: BoundsDelta | null;
	/** The element sits under a v1.2 masked region, so this frame cannot visually confirm it. */
	visuallyMasked: boolean;
}

export interface ReplayStepResult {
	stepId: string;
	beatId: string;
	label: string;
	action: InputAction;
	status: StepStatus;
	targets: TargetResolution[];
	startedAtMs: number;
	elapsedMs: number;
	/** Offset from the start of the replay at which the step completed. */
	offsetMs: number;
	baselineOffsetMs: number;
	baselineElapsedMs: number;
	frameId: string | null;
	beat: Beat | null;
	error: string | null;
}

export interface ReplayRecordingOutcome {
	recordingId: string;
	projectPath: string;
	durationMs: number;
	measuredFps: number;
	width: number;
	height: number;
	beats: Beat[];
}

export interface ReplayRun {
	planVersion: 1;
	projectPath: string;
	sessionId: string;
	status: StepStatus;
	startedAtMs: number;
	finishedAtMs: number;
	durationMs: number;
	steps: ReplayStepResult[];
	/** Steps never attempted because an earlier step broke. Not a verdict about them. */
	skippedStepIds: string[];
	recording: ReplayRecordingOutcome | null;
}

export interface ReplayRunOptions {
	pack: CapToolPack;
	plan: ReplayPlan;
	sessionId: string;
	approvalId?: string;
	ctx?: ToolContext;
	now?: () => number;
	/** Keep going after a broken step. Off by default: later steps depend on earlier ones. */
	continueAfterBreak?: boolean;
	/** Pixels a bound may shift before it counts as movement. Default 2. */
	boundsTolerancePx?: number;
	/** Jaccard threshold for the `label` criterion of last resort. Default 0.5. */
	labelMatchThreshold?: number;
	observeRequest?: Partial<ObserveRequest>;
	/** Re-shoot footage while replaying, so the diff can ship a current video. */
	recording?: StartRecordingRequest;
}

// ── Observation elements ─────────────────────────────────────────────────────

interface ObservedElement {
	elementId: string;
	role: string;
	title: string | null;
	identifier: string | null;
	bounds: Rect;
	enabled: boolean;
	focused: boolean;
}

interface Observation {
	frameId: string;
	elements: ObservedElement[];
	elementsTruncated: boolean;
	maskedRegions: Rect[];
}

function normalize(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function tokens(value: string): string[] {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.split(" ")
		.filter((token) => token.length > 0);
}

function jaccard(a: string[], b: string[]): number {
	if (a.length === 0 || b.length === 0) return 0;
	const left = new Set(a);
	const right = new Set(b);
	let shared = 0;
	for (const token of left) if (right.has(token)) shared += 1;
	const union = left.size + right.size - shared;
	return union === 0 ? 0 : shared / union;
}

function roleOrdinals(elements: ObservedElement[]): number[] {
	const seen = new Map<string, number>();
	return elements.map((element) => {
		const next = seen.get(element.role) ?? 0;
		seen.set(element.role, next + 1);
		return next;
	});
}

function rectsIntersect(a: Rect, b: Rect): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

interface CriterionMatch {
	criterion: MatchCriterion;
	indexes: number[];
}

function candidatesFor(
	criterion: MatchCriterion,
	query: ElementQuery,
	elements: ObservedElement[],
	ordinals: number[],
	label: string,
	labelThreshold: number
): number[] | null {
	const indexes: number[] = [];
	switch (criterion) {
		case "identifier": {
			if (query.identifier === null) return null;
			elements.forEach((element, index) => {
				if (normalize(element.identifier) === query.identifier) indexes.push(index);
			});
			return indexes;
		}
		case "roleAndTitle": {
			if (query.role === null || query.title === null) return null;
			elements.forEach((element, index) => {
				if (element.role === query.role && normalize(element.title) === query.title) {
					indexes.push(index);
				}
			});
			return indexes;
		}
		case "title": {
			if (query.title === null) return null;
			elements.forEach((element, index) => {
				if (normalize(element.title) === query.title) indexes.push(index);
			});
			return indexes;
		}
		case "roleAndOrder": {
			if (query.role === null || query.nth === null) return null;
			elements.forEach((element, index) => {
				if (element.role === query.role && ordinals[index] === query.nth) indexes.push(index);
			});
			return indexes;
		}
		case "label": {
			const labelTokens = tokens(label);
			if (labelTokens.length === 0) return null;
			elements.forEach((element, index) => {
				const title = normalize(element.title);
				if (title === null) return;
				if (jaccard(labelTokens, tokens(title)) >= labelThreshold) indexes.push(index);
			});
			return indexes;
		}
		case "role": {
			if (query.role === null) return null;
			elements.forEach((element, index) => {
				if (element.role === query.role) indexes.push(index);
			});
			return indexes;
		}
	}
}

interface Resolution {
	index: number;
	criterion: MatchCriterion;
	byOrder: boolean;
}

function resolveTarget(
	target: ReplayPlanTarget,
	observation: Observation,
	labelThreshold: number
): Resolution | { ambiguous: CriterionMatch } | null {
	const ordinals = roleOrdinals(observation.elements);
	const baselineStrength = criterionStrength(target.criterion);
	for (const criterion of orderedCriteria(target)) {
		const raw = candidatesFor(
			criterion,
			target.query,
			observation.elements,
			ordinals,
			target.label,
			labelThreshold
		);
		if (raw === null || raw.length === 0) continue;
		// Below the shoot's own criterion, an element carrying a different accessibility identifier
		// is positive evidence of a different element. Without this, "same role, same position"
		// happily lands a deleted Save button on whatever button took its slot, and a breakage is
		// misreported as drift.
		const indexes =
			criterionStrength(criterion) < baselineStrength && target.query.identifier !== null
				? raw.filter((index) => {
						const identifier = normalize(observation.elements[index].identifier);
						return identifier === null || identifier === target.query.identifier;
					})
				: raw;
		if (indexes.length === 0) continue;
		if (indexes.length === 1) return { index: indexes[0], criterion, byOrder: false };
		if (target.query.nth !== null) {
			const narrowed = indexes.filter((index) => ordinals[index] === target.query.nth);
			if (narrowed.length === 1) return { index: narrowed[0], criterion, byOrder: true };
		}
		return { ambiguous: { criterion, indexes } };
	}
	return null;
}

/**
 * Criteria to try, strongest first. Never stronger than the shoot itself managed, and never
 * weaker than `FALLBACK_FLOOR` — a fallback below that resolves onto the wrong element and
 * reports drift where the truth is that the flow is gone.
 */
function orderedCriteria(target: ReplayPlanTarget): MatchCriterion[] {
	const ceiling = criterionStrength(target.criterion);
	const floor = Math.min(ceiling, criterionStrength(FALLBACK_FLOOR));
	return MATCH_CRITERIA.filter((criterion) => {
		const strength = criterionStrength(criterion);
		return strength <= ceiling && strength >= floor;
	});
}

function toResolvedElement(element: ObservedElement, ordinal: number): ResolvedElement {
	return {
		elementId: element.elementId,
		role: element.role,
		title: element.title,
		identifier: element.identifier,
		bounds: element.bounds,
		enabled: element.enabled,
		focused: element.focused,
		ordinal,
	};
}

function boundsDelta(baseline: Rect, current: Rect): BoundsDelta {
	return {
		dx: current.x - baseline.x,
		dy: current.y - baseline.y,
		dWidth: current.width - baseline.width,
		dHeight: current.height - baseline.height,
	};
}

function classify(
	target: ReplayPlanTarget,
	resolution: Resolution,
	observation: Observation,
	tolerance: number
): TargetResolution {
	const element = observation.elements[resolution.index];
	const ordinals = roleOrdinals(observation.elements);
	const resolved = toResolvedElement(element, ordinals[resolution.index]);
	const delta = boundsDelta(target.baseline.bounds, resolved.bounds);
	const drift: DriftReason[] = [];

	if (criterionStrength(resolution.criterion) < criterionStrength(target.criterion)) {
		drift.push("weaker_match");
	}
	if (resolution.byOrder) drift.push("ambiguity_resolved_by_order");
	if (normalize(resolved.role) !== normalize(target.baseline.role)) drift.push("role_changed");
	if (normalize(resolved.title) !== normalize(target.baseline.title)) drift.push("renamed");
	if (normalize(resolved.identifier) !== normalize(target.baseline.identifier)) {
		drift.push("reidentified");
	}
	if (Math.abs(delta.dx) > tolerance || Math.abs(delta.dy) > tolerance) drift.push("moved");
	if (Math.abs(delta.dWidth) > tolerance || Math.abs(delta.dHeight) > tolerance) {
		drift.push("resized");
	}
	if (target.slot === "focus" && resolved.focused === false) drift.push("focus_lost");

	const visuallyMasked = observation.maskedRegions.some((region) =>
		rectsIntersect(region, resolved.bounds)
	);

	if (target.required && resolved.enabled === false) {
		return {
			slot: target.slot,
			label: target.label,
			query: target.query,
			status: "broken",
			baselineCriterion: target.criterion,
			criterion: resolution.criterion,
			baseline: target.baseline,
			resolved,
			drift,
			breakage: "element_disabled",
			boundsDelta: delta,
			visuallyMasked,
		};
	}

	return {
		slot: target.slot,
		label: target.label,
		query: target.query,
		status: drift.length > 0 ? "drifted" : "matched",
		baselineCriterion: target.criterion,
		criterion: resolution.criterion,
		baseline: target.baseline,
		resolved,
		drift,
		breakage: null,
		boundsDelta: delta,
		visuallyMasked,
	};
}

function brokenTarget(
	target: ReplayPlanTarget,
	breakage: BreakageReason,
	criterion: MatchCriterion | null
): TargetResolution {
	return {
		slot: target.slot,
		label: target.label,
		query: target.query,
		status: "broken",
		baselineCriterion: target.criterion,
		criterion,
		baseline: target.baseline,
		resolved: null,
		drift: [],
		breakage,
		boundsDelta: null,
		visuallyMasked: false,
	};
}

function worst(statuses: StepStatus[]): StepStatus {
	if (statuses.includes("broken")) return "broken";
	if (statuses.includes("drifted")) return "drifted";
	return "matched";
}

/** Re-point an action at the elements this run resolved. Never at the coordinates it was shot at. */
export function retargetAction(
	action: InputAction,
	targets: Partial<Record<TargetSlot, Target>>
): InputAction {
	switch (action.type) {
		case "moveTo":
			return targets.target ? { ...action, target: targets.target } : action;
		case "click":
			return targets.target ? { ...action, target: targets.target } : action;
		case "scroll":
			return targets.target ? { ...action, target: targets.target } : action;
		case "drag":
			return {
				...action,
				from: targets.from ?? action.from,
				to: targets.to ?? action.to,
			};
		default:
			return action;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function runReplay(options: ReplayRunOptions): Promise<ReplayRun> {
	const {
		pack,
		plan,
		sessionId,
		approvalId,
		ctx = {},
		continueAfterBreak = false,
		boundsTolerancePx = 2,
		labelMatchThreshold = 0.5,
	} = options;
	const now = options.now ?? (() => Date.now());
	const observeRequest: ObserveRequest = {
		displayId: null,
		maxDimension: null,
		...options.observeRequest,
		includeElements: true,
	};

	const startedAtMs = now();
	let recording: ReplayRecordingOutcome | null = null;
	if (options.recording) {
		await pack.recordingStart.execute(
			{ sessionId, approvalId, request: options.recording },
			ctx
		);
	}

	const steps: ReplayStepResult[] = [];
	const skippedStepIds: string[] = [];
	let halted = false;

	for (const planStep of plan.steps) {
		if (halted) {
			skippedStepIds.push(planStep.stepId);
			continue;
		}
		const result = await runStep(planStep, {
			pack,
			sessionId,
			approvalId,
			ctx,
			observeRequest,
			boundsTolerancePx,
			labelMatchThreshold,
			now,
			runStartedAtMs: startedAtMs,
		});
		steps.push(result);
		if (result.status === "broken" && !continueAfterBreak) halted = true;
	}

	if (options.recording) {
		const stopped = await pack.recordingStop.execute({ sessionId, approvalId }, ctx);
		recording = {
			recordingId: stopped.recordingId,
			projectPath: stopped.projectPath,
			durationMs: stopped.durationMs,
			measuredFps: stopped.measuredFps,
			width: stopped.width,
			height: stopped.height,
			beats: stopped.beats,
		};
	}

	const finishedAtMs = now();
	return {
		planVersion: 1,
		projectPath: plan.projectPath,
		sessionId,
		status: worst(steps.map((step) => step.status)),
		startedAtMs,
		finishedAtMs,
		durationMs: Math.max(0, finishedAtMs - startedAtMs),
		steps,
		skippedStepIds,
		recording,
	};
}

interface StepContext {
	pack: CapToolPack;
	sessionId: string;
	approvalId?: string;
	ctx: ToolContext;
	observeRequest: ObserveRequest;
	boundsTolerancePx: number;
	labelMatchThreshold: number;
	now: () => number;
	runStartedAtMs: number;
}

async function runStep(
	planStep: ReplayPlanStep,
	context: StepContext
): Promise<ReplayStepResult> {
	const startedAtMs = context.now();
	const base = {
		stepId: planStep.stepId,
		beatId: planStep.beatId,
		label: planStep.label,
		action: planStep.action,
		startedAtMs,
		baselineOffsetMs: planStep.offsetMs,
		baselineElapsedMs: planStep.baselineElapsedMs,
	};

	let observation: Observation;
	try {
		const summary = await context.pack.observe.execute(
			{
				sessionId: context.sessionId,
				approvalId: context.approvalId,
				request: context.observeRequest,
			},
			context.ctx
		);
		observation = {
			frameId: summary.frameId,
			elements: summary.elements.map((element) => ({
				elementId: element.elementId,
				role: element.role,
				title: element.title,
				identifier: element.identifier,
				bounds: element.bounds,
				enabled: element.enabled,
				focused: element.focused,
			})),
			elementsTruncated: summary.elementsTruncated,
			maskedRegions: summary.maskedRegions ?? [],
		};
	} catch (error) {
		const finished = context.now();
		return {
			...base,
			status: "broken",
			targets: planStep.targets.map((target) =>
				brokenTarget(target, "observation_failed", null)
			),
			elapsedMs: Math.max(0, finished - startedAtMs),
			offsetMs: Math.max(0, finished - context.runStartedAtMs),
			frameId: null,
			beat: null,
			error: errorMessage(error),
		};
	}

	const resolutions: TargetResolution[] = [];
	const retarget: Partial<Record<TargetSlot, Target>> = {};

	for (const target of planStep.targets) {
		const outcome = resolveTarget(target, observation, context.labelMatchThreshold);
		if (outcome === null) {
			resolutions.push(
				brokenTarget(
					target,
					observation.elementsTruncated ? "element_list_truncated" : "unresolved",
					null
				)
			);
			continue;
		}
		if ("ambiguous" in outcome) {
			resolutions.push(brokenTarget(target, "ambiguous", outcome.ambiguous.criterion));
			continue;
		}
		const classified = classify(target, outcome, observation, context.boundsTolerancePx);
		resolutions.push(classified);
		if (
			target.slot !== "focus" &&
			classified.resolved !== null &&
			classified.status !== "broken"
		) {
			retarget[target.slot] = { type: "element", elementId: observation.elements[outcome.index].elementId };
		}
	}

	// A verify-only slot that cannot be found is drift, not breakage: the flow can still run, but
	// the frame the docs show is no longer the frame the step produces.
	for (const [index, resolution] of resolutions.entries()) {
		const planned = planStep.targets[index];
		if (!planned.required && resolution.status === "broken") {
			resolutions[index] = { ...resolution, status: "drifted" };
		}
	}
	const resolutionStatus = worst(resolutions.map((resolution) => resolution.status));

	if (resolutionStatus === "broken") {
		const finished = context.now();
		return {
			...base,
			status: "broken",
			targets: resolutions,
			elapsedMs: Math.max(0, finished - startedAtMs),
			offsetMs: Math.max(0, finished - context.runStartedAtMs),
			frameId: observation.frameId,
			beat: null,
			error: null,
		};
	}

	try {
		const acted = await context.pack.act.execute(
			{
				sessionId: context.sessionId,
				approvalId: context.approvalId,
				action: retargetAction(planStep.action, retarget),
				beatLabel: planStep.label,
			},
			context.ctx
		);
		const finished = context.now();
		return {
			...base,
			status: resolutionStatus,
			targets: resolutions,
			elapsedMs: Math.max(0, finished - startedAtMs),
			offsetMs: Math.max(0, finished - context.runStartedAtMs),
			frameId: observation.frameId,
			beat: acted.beat,
			error: null,
		};
	} catch (error) {
		const finished = context.now();
		return {
			...base,
			status: "broken",
			targets: resolutions.map((resolution) =>
				resolution.status === "broken"
					? resolution
					: { ...resolution, status: "broken" as const, breakage: "action_failed" as const }
			),
			elapsedMs: Math.max(0, finished - startedAtMs),
			offsetMs: Math.max(0, finished - context.runStartedAtMs),
			frameId: observation.frameId,
			beat: null,
			error: errorMessage(error),
		};
	}
}

/** The offset a replayed step landed at, preferring the runner's own beat over wall clock. */
export function replayOffsetMs(step: ReplayStepResult): number {
	return step.beat?.offsetMs ?? step.offsetMs;
}
