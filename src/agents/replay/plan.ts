/**
 * Replay planning.
 *
 * A `Storyboard` is typed, deterministic and separate from its footage, so the same storyboard can
 * be re-shot against a changed application. This module derives the sequence of steps that
 * reproduces the original flow.
 *
 * The load-bearing rule: a step is only replayable if it can be *re-resolved semantically* — by
 * the accessibility `identifier`, by `role` + `title`, or, as a last resort, by the beat `label`.
 * Raw coordinates and session-scoped element handles are not re-resolvable: a point clicks
 * whatever now happens to be at that pixel, and an `elementId` from last week's session names
 * nothing today. Both would still "pass" against a UI that had changed underneath them, which is
 * exactly the failure a re-shoot is meant to catch. `buildReplayPlan` therefore refuses them
 * rather than degrading quietly.
 */

import { AgentError } from "../errors/index";
import { DEFAULT_EDITORIAL_LIMITS } from "../tools/cap/types";
import type {
	Beat,
	BeatKind,
	CaptureGeometry,
	EditorialLimits,
	InputAction,
	Rect,
	Storyboard,
	Target,
} from "../tools/cap/types";

// ── Element identity ─────────────────────────────────────────────────────────

/** Where in an action a target sits. `focus` is verified, never clicked. */
export type TargetSlot = "target" | "from" | "to" | "focus";

/**
 * How an element was re-found, strongest first. A replay that resolves by a weaker criterion than
 * the shoot did is drift even when it lands on the right element: the stable handle is gone.
 */
export const MATCH_CRITERIA = [
	"identifier",
	"roleAndTitle",
	"title",
	"label",
	"roleAndOrder",
	"role",
] as const;
export type MatchCriterion = (typeof MATCH_CRITERIA)[number];

/** Higher is stronger. */
export function criterionStrength(criterion: MatchCriterion): number {
	return MATCH_CRITERIA.length - MATCH_CRITERIA.indexOf(criterion);
}

/**
 * The weakest criterion a replay may fall back to. Bare `role` matches "some button" and would
 * happily resolve a deleted Save button onto whatever other button is left, reporting drift where
 * the honest answer is breakage. It is only permitted when the shoot itself had nothing better.
 */
export const FALLBACK_FLOOR: MatchCriterion = "roleAndOrder";

export interface ResolvedElement {
	/** Session-scoped handle. Recorded for provenance only; never used to re-resolve. */
	elementId?: string;
	role: string;
	title?: string | null;
	identifier?: string | null;
	bounds: Rect;
	enabled?: boolean;
	focused?: boolean;
	/** Zero-based index of this element among elements sharing its `role` in the same frame. */
	ordinal?: number | null;
}

/** The re-resolvable description of an element. Mirrors the protocol's `elementQuery` target. */
export interface ElementQuery {
	role: string | null;
	title: string | null;
	identifier: string | null;
	/** Index among same-role elements in the frame, used to break ties. */
	nth: number | null;
}

export function elementQueryTarget(query: ElementQuery): Target {
	return {
		type: "elementQuery",
		role: query.role,
		title: query.title,
		identifier: query.identifier,
		nth: query.nth,
	};
}

export function describeQuery(query: ElementQuery): string {
	const parts: string[] = [];
	if (query.identifier) parts.push(`identifier=${query.identifier}`);
	if (query.role) parts.push(`role=${query.role}`);
	if (query.title !== null) parts.push(`title=${JSON.stringify(query.title)}`);
	if (query.nth !== null) parts.push(`nth=${query.nth}`);
	return parts.length > 0 ? parts.join(" ") : "<empty>";
}

function nonEmpty(value: string | null | undefined): string | null {
	if (value === null || value === undefined) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function queryForElement(element: ResolvedElement): ElementQuery {
	return {
		role: nonEmpty(element.role),
		title: nonEmpty(element.title),
		identifier: nonEmpty(element.identifier),
		nth: element.ordinal ?? null,
	};
}

/**
 * The strongest criterion this query can be re-resolved by. `null` means it cannot be — which is
 * the refusal case, not a weak-but-usable one.
 */
export function strongestCriterion(query: ElementQuery): MatchCriterion | null {
	if (query.identifier !== null) return "identifier";
	if (query.role !== null && query.title !== null) return "roleAndTitle";
	if (query.title !== null) return "title";
	if (query.role !== null && query.nth !== null) return "roleAndOrder";
	if (query.role !== null) return "role";
	return null;
}

// ── Coordinate refusal ───────────────────────────────────────────────────────

/**
 * True for targets that name a position rather than a thing. These are the targets a replay must
 * never accept: they always resolve, and they resolve to whatever moved into that spot.
 */
export function isCoordinateOnly(target: Target): target is Extract<Target, { type: "point" }> {
	return target.type === "point";
}

/** True for a target that names a handle only valid inside the session that produced it. */
export function isOpaqueHandle(target: Target): target is Extract<Target, { type: "element" }> {
	return target.type === "element";
}

/** Slots an action cannot be replayed without. `focus` is optional, so it is not listed. */
export function requiredTargetSlots(action: InputAction): TargetSlot[] {
	switch (action.type) {
		case "moveTo":
		case "click":
		case "scroll":
			return ["target"];
		case "drag":
			return ["from", "to"];
		default:
			return [];
	}
}

export function targetForSlot(action: InputAction, slot: TargetSlot): Target | null {
	if (slot === "from") return action.type === "drag" ? action.from : null;
	if (slot === "to") return action.type === "drag" ? action.to : null;
	if (slot !== "target") return null;
	switch (action.type) {
		case "moveTo":
		case "click":
		case "scroll":
			return action.target;
		default:
			return null;
	}
}

// ── The recorded shoot ───────────────────────────────────────────────────────

/** One thing the agent did during the original shoot, paired with what it resolved against. */
export interface ShootAction {
	beatId: string;
	action: InputAction;
	/** What each of the action's targets resolved to at shoot time. */
	resolved?: Partial<Record<TargetSlot, ResolvedElement>>;
	/** Wall-clock the step took during the shoot, used as the timing baseline. */
	elapsedMs?: number;
}

/** A stored shoot: the storyboard, the beat log it was cut from, and what produced each beat. */
export interface ShootRecord {
	storyboard: Storyboard;
	beats: Beat[];
	actions: ShootAction[];
	durationMs: number;
	measuredFps?: number;
	/** Protocol v1.2 capture geometry. Lets bounds drift be reported as a fraction of the frame. */
	capture?: CaptureGeometry;
}

// ── Issues ───────────────────────────────────────────────────────────────────

export type ReplayPlanIssueCode =
	| "coordinate_only_target"
	| "opaque_element_handle"
	| "unqueryable_element"
	| "missing_target"
	| "unknown_beat"
	| "no_replayable_steps"
	| "weak_query"
	| "non_replayable_beat";

export interface ReplayPlanIssue {
	code: ReplayPlanIssueCode;
	severity: "refusal" | "warning";
	message: string;
	beatId?: string;
	slot?: TargetSlot;
}

export class ReplayPlanError extends AgentError {
	readonly issues: ReplayPlanIssue[];

	constructor(issues: ReplayPlanIssue[]) {
		super(
			`Shoot cannot be replayed as a regression test: ${issues.map((i) => i.message).join("; ")}`,
			"REPLAY_PLAN_INVALID",
			"Re-shoot with element targets. A replay driven by coordinates or session-scoped element handles passes against any UI and tests nothing."
		);
		this.name = "ReplayPlanError";
		this.issues = issues;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface ReplayPlanTarget {
	slot: TargetSlot;
	/** The semantic anchor: what the beat said this step was for. */
	label: string;
	query: ElementQuery;
	/** Strongest criterion the shoot's own resolution supports. */
	criterion: MatchCriterion;
	baseline: ResolvedElement;
	/** False for `focus`, which is verified but never required to complete the step. */
	required: boolean;
}

export interface ReplayPlanStep {
	stepId: string;
	beatId: string;
	beatKind: BeatKind;
	label: string;
	/** Offset of the beat in the original footage. */
	offsetMs: number;
	baselineElapsedMs: number;
	action: InputAction;
	targets: ReplayPlanTarget[];
}

export interface ReplayPlan {
	planVersion: 1;
	projectPath: string;
	storyboard: Storyboard;
	beats: Beat[];
	durationMs: number;
	limits: EditorialLimits;
	capture: CaptureGeometry | null;
	steps: ReplayPlanStep[];
	/** Beats carrying an action the plan deliberately does not replay. */
	skippedBeatIds: string[];
	warnings: ReplayPlanIssue[];
}

export interface BuildReplayPlanOptions {
	limits?: EditorialLimits;
	/** Beat kinds that produce a replay step. Defaults to the two the agent authored. */
	replayableBeatKinds?: readonly BeatKind[];
}

const DEFAULT_REPLAYABLE_BEAT_KINDS: readonly BeatKind[] = ["action", "typing"];

function slotIssue(
	target: Target | null,
	resolved: ResolvedElement | undefined,
	beatId: string,
	slot: TargetSlot
): ReplayPlanIssue | null {
	if (resolved !== undefined) {
		if (strongestCriterion(queryForElement(resolved)) === null) {
			return {
				code: "unqueryable_element",
				severity: "refusal",
				message: `Beat "${beatId}" slot "${slot}" resolved to an element with no role, title or identifier, so nothing about it can be re-found.`,
				beatId,
				slot,
			};
		}
		return null;
	}
	if (target === null) {
		return {
			code: "missing_target",
			severity: "refusal",
			message: `Beat "${beatId}" needs a "${slot}" target and the shoot recorded none.`,
			beatId,
			slot,
		};
	}
	if (isCoordinateOnly(target)) {
		return {
			code: "coordinate_only_target",
			severity: "refusal",
			message: `Beat "${beatId}" slot "${slot}" was driven by raw coordinates. Replaying a point clicks whatever now sits there, so it can never fail.`,
			beatId,
			slot,
		};
	}
	if (isOpaqueHandle(target)) {
		return {
			code: "opaque_element_handle",
			severity: "refusal",
			message: `Beat "${beatId}" slot "${slot}" names element handle "${target.elementId}", which is scoped to the session that produced it and means nothing in a later run.`,
			beatId,
			slot,
		};
	}
	return null;
}

/** Every problem with a stored shoot, refusals and warnings alike. Never throws. */
export function inspectShootRecord(
	record: ShootRecord,
	options: BuildReplayPlanOptions = {}
): ReplayPlanIssue[] {
	return collect(record, options).issues;
}

interface Collected {
	issues: ReplayPlanIssue[];
	steps: ReplayPlanStep[];
	skippedBeatIds: string[];
}

function collect(record: ShootRecord, options: BuildReplayPlanOptions): Collected {
	const replayable = new Set<BeatKind>(
		options.replayableBeatKinds ?? DEFAULT_REPLAYABLE_BEAT_KINDS
	);
	const beatsById = new Map(record.beats.map((beat) => [beat.beatId, beat]));
	const issues: ReplayPlanIssue[] = [];
	const skippedBeatIds: string[] = [];

	const ordered = record.actions
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => {
			const aBeat = beatsById.get(a.entry.beatId);
			const bBeat = beatsById.get(b.entry.beatId);
			const delta = (aBeat?.offsetMs ?? 0) - (bBeat?.offsetMs ?? 0);
			return delta !== 0 ? delta : a.index - b.index;
		});

	const steps: ReplayPlanStep[] = [];

	for (const { entry } of ordered) {
		const beat = beatsById.get(entry.beatId);
		if (!beat) {
			issues.push({
				code: "unknown_beat",
				severity: "refusal",
				message: `Shoot action references beat "${entry.beatId}", which is not in the beat log.`,
				beatId: entry.beatId,
			});
			continue;
		}

		if (!replayable.has(beat.kind)) {
			skippedBeatIds.push(beat.beatId);
			issues.push({
				code: "non_replayable_beat",
				severity: "warning",
				message: `Beat "${beat.beatId}" is a ${beat.kind} beat; it carries an action but is not part of the replayed flow.`,
				beatId: beat.beatId,
			});
			continue;
		}

		const resolvedBySlot = entry.resolved ?? {};
		const targets: ReplayPlanTarget[] = [];
		let refused = false;

		const slots: Array<{ slot: TargetSlot; required: boolean }> = [
			...requiredTargetSlots(entry.action).map((slot) => ({ slot, required: true })),
		];
		if (resolvedBySlot.focus !== undefined) slots.push({ slot: "focus", required: false });

		for (const { slot, required } of slots) {
			const resolved = resolvedBySlot[slot];
			const issue = slotIssue(targetForSlot(entry.action, slot), resolved, beat.beatId, slot);
			if (issue) {
				issues.push(issue);
				if (issue.severity === "refusal") refused = true;
				continue;
			}
			if (resolved === undefined) continue;

			const query = queryForElement(resolved);
			const criterion = strongestCriterion(query);
			if (criterion === null) continue;
			if (criterion === "role" || criterion === "label") {
				issues.push({
					code: "weak_query",
					severity: "warning",
					message: `Beat "${beat.beatId}" slot "${slot}" can only be re-resolved by ${criterion}; a rename or a re-order will read as breakage.`,
					beatId: beat.beatId,
					slot,
				});
			}
			targets.push({
				slot,
				label: beat.label,
				query,
				criterion,
				baseline: resolved,
				required,
			});
		}

		if (refused) continue;

		steps.push({
			stepId: `step-${steps.length + 1}`,
			beatId: beat.beatId,
			beatKind: beat.kind,
			label: beat.label,
			offsetMs: beat.offsetMs,
			baselineElapsedMs: Math.max(0, entry.elapsedMs ?? 0),
			action: entry.action,
			targets,
		});
	}

	if (steps.length === 0) {
		issues.push({
			code: "no_replayable_steps",
			severity: "refusal",
			message: "The shoot produced no replayable step, so there is no flow to re-run.",
		});
	}

	return { issues, steps, skippedBeatIds };
}

/**
 * Derive the replay plan. Throws `ReplayPlanError` when any step could only be reproduced from
 * coordinates or a stale element handle — a plan that falls back to those has stopped being a
 * regression test, and failing loudly here is the whole point.
 */
export function buildReplayPlan(
	record: ShootRecord,
	options: BuildReplayPlanOptions = {}
): ReplayPlan {
	const { issues, steps, skippedBeatIds } = collect(record, options);
	const refusals = issues.filter((issue) => issue.severity === "refusal");
	if (refusals.length > 0) throw new ReplayPlanError(refusals);

	return {
		planVersion: 1,
		projectPath: record.storyboard.projectPath,
		storyboard: record.storyboard,
		beats: record.beats.slice().sort((a, b) => a.offsetMs - b.offsetMs),
		durationMs: record.durationMs,
		limits: options.limits ?? DEFAULT_EDITORIAL_LIMITS,
		capture: record.capture ?? null,
		steps,
		skippedBeatIds,
		warnings: issues.filter((issue) => issue.severity === "warning"),
	};
}

/** Human-readable rendering of a plan, for logs and CI output. Deterministic. */
export function renderReplayPlan(plan: ReplayPlan): string {
	const lines: string[] = [
		`Replay plan for ${plan.projectPath}`,
		`  ${plan.steps.length} step(s), baseline footage ${plan.durationMs}ms, ${plan.storyboard.shots.length} shot(s)`,
	];
	for (const step of plan.steps) {
		lines.push(`  ${step.stepId} @${step.offsetMs}ms ${step.action.type} — ${step.label}`);
		for (const target of step.targets) {
			lines.push(
				`    ${target.slot}: ${target.criterion} (${describeQuery(target.query)})${target.required ? "" : " [verify only]"}`
			);
		}
	}
	for (const warning of plan.warnings) {
		lines.push(`  warning [${warning.code}] ${warning.message}`);
	}
	return lines.join("\n");
}
