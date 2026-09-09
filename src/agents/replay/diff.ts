/**
 * Replay diff.
 *
 * A storyboard is separate from its footage, so a replay can be compared against the shoot that
 * produced the baseline: which steps drifted and how, which broke, how the timing moved, and —
 * the part a screen recorder cannot do at all — whether the editorial constraints the cut was
 * compiled under still hold. A step that now takes three times as long stretches every shot after
 * it, and the twelve-second limit is the first thing to give.
 *
 * The projection is a piecewise-linear time warp anchored on the beats themselves: baseline beat
 * offset maps to replay beat offset, with (0, 0) and (baseline duration, replay duration) closing
 * the ends. Everything here is pure and deterministic.
 */

import { shotExtensions } from "../tools/cap/types";
import { storyboardDurationMs, validateStoryboard } from "../tools/cap/storyboard";
import type { StoryboardIssue } from "../tools/cap/storyboard";
import type { EditorialLimits, Shot, Storyboard } from "../tools/cap/types";
import type { MatchCriterion, ReplayPlan, ResolvedElement, TargetSlot } from "./plan";
import { criterionStrength, describeQuery } from "./plan";
import { replayOffsetMs } from "./run";
import type {
	BoundsDelta,
	BreakageReason,
	DriftReason,
	ReplayRun,
	StepStatus,
} from "./run";

export interface ElementSnapshot {
	role: string;
	title: string | null;
	identifier: string | null;
}

export interface TargetDiff {
	slot: TargetSlot;
	status: StepStatus;
	baselineCriterion: MatchCriterion;
	criterion: MatchCriterion | null;
	criterionWeakened: boolean;
	drift: DriftReason[];
	breakage: BreakageReason | null;
	before: ElementSnapshot;
	after: ElementSnapshot | null;
	boundsDelta: BoundsDelta | null;
	/** Movement as a fraction of the capture frame, when v1.2 geometry is known. */
	boundsDeltaFraction: { dx: number; dy: number } | null;
	visuallyMasked: boolean;
	description: string;
}

export interface StepDiff {
	stepId: string;
	beatId: string;
	label: string;
	status: StepStatus | "skipped";
	baselineElapsedMs: number;
	replayElapsedMs: number;
	elapsedDeltaMs: number;
	baselineOffsetMs: number;
	replayOffsetMs: number;
	targets: TargetDiff[];
	error: string | null;
}

export interface TimingDiff {
	baselineDurationMs: number;
	replayDurationMs: number;
	deltaMs: number;
	slowestStepId: string | null;
	/** Steps whose elapsed time grew by at least `timingRegressionRatio`. */
	regressions: Array<{
		stepId: string;
		label: string;
		baselineMs: number;
		replayMs: number;
		ratio: number;
	}>;
}

export interface EditorialDiff {
	limits: EditorialLimits;
	baselineTotalMs: number;
	projectedTotalMs: number;
	/** The original storyboard with every shot span warped onto the replay's timeline. */
	projectedStoryboard: Storyboard;
	issues: StoryboardIssue[];
	withinLimits: boolean;
}

export interface ReplayDiff {
	projectPath: string;
	status: StepStatus;
	summary: {
		total: number;
		matched: number;
		drifted: number;
		broken: number;
		skipped: number;
	};
	steps: StepDiff[];
	timing: TimingDiff;
	editorial: EditorialDiff;
	/** Set when the replay re-shot footage, so the current video is addressable. */
	refreshedProjectPath: string | null;
	notes: string[];
}

export interface DiffReplayOptions {
	limits?: EditorialLimits;
	/** Growth factor at which a step's timing counts as a regression. Default 1.5. */
	timingRegressionRatio?: number;
}

// ── Time warp ────────────────────────────────────────────────────────────────

export interface WarpAnchor {
	baselineMs: number;
	replayMs: number;
}

/**
 * Build a monotonic piecewise-linear map from baseline footage time to replay footage time.
 * Anchors that would run backwards are pinned forward rather than dropped, so the map is total.
 */
export function buildTimeWarp(anchors: WarpAnchor[]): (ms: number) => number {
	const sorted = anchors
		.slice()
		.sort((a, b) => a.baselineMs - b.baselineMs || a.replayMs - b.replayMs);

	const points: WarpAnchor[] = [];
	for (const anchor of sorted) {
		const previous = points.at(-1);
		if (previous && anchor.baselineMs === previous.baselineMs) continue;
		points.push({
			baselineMs: anchor.baselineMs,
			replayMs: previous ? Math.max(anchor.replayMs, previous.replayMs) : anchor.replayMs,
		});
	}
	if (points.length === 0) return (ms) => ms;
	if (points.length === 1) {
		const only = points[0];
		const shift = only.replayMs - only.baselineMs;
		return (ms) => ms + shift;
	}

	return (ms) => {
		const first = points[0];
		const last = points[points.length - 1];
		if (ms <= first.baselineMs) return first.replayMs + (ms - first.baselineMs);
		if (ms >= last.baselineMs) return last.replayMs + (ms - last.baselineMs);
		for (let i = 1; i < points.length; i++) {
			const right = points[i];
			if (ms > right.baselineMs) continue;
			const left = points[i - 1];
			const span = right.baselineMs - left.baselineMs;
			if (span === 0) return right.replayMs;
			const t = (ms - left.baselineMs) / span;
			return left.replayMs + t * (right.replayMs - left.replayMs);
		}
		return last.replayMs;
	};
}

/** Total runtime of a cut, including the time its transitions take. */
export function cutDurationMs(storyboard: Storyboard): number {
	const shots = storyboard.shots;
	const transitions = shots
		.slice(1)
		.reduce((total, shot) => total + shotExtensions(shot).transitionDurationMs, 0);
	return storyboardDurationMs(storyboard) + transitions;
}

function projectShot(shot: Shot, warp: (ms: number) => number): Shot {
	const start = Math.max(0, Math.round(warp(shot.sourceStartMs)));
	const end = Math.max(start, Math.round(warp(shot.sourceEndMs)));
	return { ...shot, sourceStartMs: start, sourceEndMs: end };
}

// ── Diff ─────────────────────────────────────────────────────────────────────

function snapshot(element: ResolvedElement): ElementSnapshot {
	return {
		role: element.role,
		title: element.title ?? null,
		identifier: element.identifier ?? null,
	};
}

function describeTarget(diff: Omit<TargetDiff, "description">): string {
	if (diff.status === "broken") {
		return `${diff.slot}: ${diff.breakage ?? "broken"} — nothing matched ${describeQuery({ role: diff.before.role, title: diff.before.title, identifier: diff.before.identifier, nth: null })}`;
	}
	if (diff.status === "matched") return `${diff.slot}: matched by ${diff.criterion}`;

	const parts: string[] = [];
	for (const reason of diff.drift) {
		switch (reason) {
			case "renamed":
				parts.push(
					`renamed ${JSON.stringify(diff.before.title)} → ${JSON.stringify(diff.after?.title ?? null)}`
				);
				break;
			case "reidentified":
				parts.push(
					`identifier ${JSON.stringify(diff.before.identifier)} → ${JSON.stringify(diff.after?.identifier ?? null)}`
				);
				break;
			case "role_changed":
				parts.push(`role ${diff.before.role} → ${diff.after?.role ?? "?"}`);
				break;
			case "moved": {
				const delta = diff.boundsDelta;
				const fraction = diff.boundsDeltaFraction;
				const suffix = fraction
					? ` (${(fraction.dx * 100).toFixed(1)}%, ${(fraction.dy * 100).toFixed(1)}% of frame)`
					: "";
				parts.push(`moved ${delta ? `${delta.dx}px, ${delta.dy}px` : "?"}${suffix}`);
				break;
			}
			case "resized":
				parts.push(
					`resized ${diff.boundsDelta ? `${diff.boundsDelta.dWidth}px × ${diff.boundsDelta.dHeight}px` : "?"}`
				);
				break;
			case "weaker_match":
				parts.push(`re-found by ${diff.criterion} instead of ${diff.baselineCriterion}`);
				break;
			case "ambiguity_resolved_by_order":
				parts.push("no longer unique; picked by position");
				break;
			case "focus_lost":
				parts.push("expected element is no longer focused");
				break;
		}
	}
	if (diff.visuallyMasked) parts.push("sits under a masked region, so the frame cannot confirm it");
	return `${diff.slot}: ${parts.join("; ")}`;
}

export function diffReplay(
	plan: ReplayPlan,
	run: ReplayRun,
	options: DiffReplayOptions = {}
): ReplayDiff {
	const limits = options.limits ?? plan.limits;
	const ratio = options.timingRegressionRatio ?? 1.5;
	const capture = plan.capture;

	const planStepsById = new Map(plan.steps.map((step) => [step.stepId, step]));
	const steps: StepDiff[] = [];
	const anchors: WarpAnchor[] = [{ baselineMs: 0, replayMs: 0 }];
	const regressions: TimingDiff["regressions"] = [];
	let slowestStepId: string | null = null;
	let slowestMs = -1;

	for (const step of run.steps) {
		const targets: TargetDiff[] = step.targets.map((target) => {
			const fraction =
				target.boundsDelta && capture && capture.width > 0 && capture.height > 0
					? {
							dx: target.boundsDelta.dx / capture.width,
							dy: target.boundsDelta.dy / capture.height,
						}
					: null;
			const partial: Omit<TargetDiff, "description"> = {
				slot: target.slot,
				status: target.status,
				baselineCriterion: target.baselineCriterion,
				criterion: target.criterion,
				criterionWeakened:
					target.criterion !== null &&
					criterionStrength(target.criterion) < criterionStrength(target.baselineCriterion),
				drift: target.drift,
				breakage: target.breakage,
				before: snapshot(target.baseline),
				after: target.resolved ? snapshot(target.resolved) : null,
				boundsDelta: target.boundsDelta,
				boundsDeltaFraction: fraction,
				visuallyMasked: target.visuallyMasked,
			};
			return { ...partial, description: describeTarget(partial) };
		});

		const replayOffset = replayOffsetMs(step);
		anchors.push({ baselineMs: step.baselineOffsetMs, replayMs: replayOffset });

		const delta = step.elapsedMs - step.baselineElapsedMs;
		if (step.elapsedMs > slowestMs) {
			slowestMs = step.elapsedMs;
			slowestStepId = step.stepId;
		}
		if (step.baselineElapsedMs > 0 && step.elapsedMs >= step.baselineElapsedMs * ratio) {
			regressions.push({
				stepId: step.stepId,
				label: step.label,
				baselineMs: step.baselineElapsedMs,
				replayMs: step.elapsedMs,
				ratio: step.elapsedMs / step.baselineElapsedMs,
			});
		}

		steps.push({
			stepId: step.stepId,
			beatId: step.beatId,
			label: step.label,
			status: step.status,
			baselineElapsedMs: step.baselineElapsedMs,
			replayElapsedMs: step.elapsedMs,
			elapsedDeltaMs: delta,
			baselineOffsetMs: step.baselineOffsetMs,
			replayOffsetMs: replayOffset,
			targets,
			error: step.error,
		});
	}

	for (const stepId of run.skippedStepIds) {
		const planStep = planStepsById.get(stepId);
		steps.push({
			stepId,
			beatId: planStep?.beatId ?? stepId,
			label: planStep?.label ?? stepId,
			status: "skipped",
			baselineElapsedMs: planStep?.baselineElapsedMs ?? 0,
			replayElapsedMs: 0,
			elapsedDeltaMs: 0,
			baselineOffsetMs: planStep?.offsetMs ?? 0,
			replayOffsetMs: 0,
			targets: [],
			error: null,
		});
	}

	const replayDurationMs = run.recording?.durationMs ?? run.durationMs;
	anchors.push({ baselineMs: plan.durationMs, replayMs: replayDurationMs });

	const warp = buildTimeWarp(anchors);
	const projectedStoryboard: Storyboard = {
		...plan.storyboard,
		shots: plan.storyboard.shots.map((shot) => projectShot(shot, warp)),
	};
	const projectedTotalMs = cutDurationMs(projectedStoryboard);
	const issues = validateStoryboard(projectedStoryboard, { limits });
	if (
		projectedTotalMs > limits.maxTotalMs &&
		!issues.some((issue) => issue.code === "total_too_long")
	) {
		issues.push({
			code: "total_too_long",
			message: `Projected cut is ${projectedTotalMs}ms including transitions, over the ${limits.maxTotalMs}ms limit.`,
		});
	}

	const summary = {
		total: steps.length,
		matched: steps.filter((step) => step.status === "matched").length,
		drifted: steps.filter((step) => step.status === "drifted").length,
		broken: steps.filter((step) => step.status === "broken").length,
		skipped: steps.filter((step) => step.status === "skipped").length,
	};

	const notes: string[] = [];
	for (const warning of plan.warnings) notes.push(`plan: ${warning.message}`);
	if (steps.some((step) => step.targets.some((target) => target.visuallyMasked))) {
		notes.push(
			"At least one element sits under a masked region; the re-shot frames cannot visually confirm it."
		);
	}
	if (run.recording === null) {
		notes.push("No footage was re-shot; timing is wall-clock from the replay, not from a capture.");
	}

	return {
		projectPath: plan.projectPath,
		status: summary.broken > 0 ? "broken" : summary.drifted > 0 ? "drifted" : "matched",
		summary,
		steps,
		timing: {
			baselineDurationMs: plan.durationMs,
			replayDurationMs,
			deltaMs: replayDurationMs - plan.durationMs,
			slowestStepId,
			regressions,
		},
		editorial: {
			limits,
			baselineTotalMs: cutDurationMs(plan.storyboard),
			projectedTotalMs,
			projectedStoryboard,
			issues,
			withinLimits: issues.length === 0,
		},
		refreshedProjectPath: run.recording?.projectPath ?? null,
		notes,
	};
}

const STATUS_MARK: Record<StepDiff["status"], string> = {
	matched: "ok  ",
	drifted: "DRIFT",
	broken: "BROKE",
	skipped: "skip",
};

/** Deterministic plain-text rendering. Same diff in, same bytes out. */
export function renderReplayDiff(diff: ReplayDiff): string {
	const lines: string[] = [];
	lines.push(`Replay diff — ${diff.projectPath}`);
	lines.push(
		`  ${diff.summary.matched} matched, ${diff.summary.drifted} drifted, ${diff.summary.broken} broken, ${diff.summary.skipped} skipped (${diff.summary.total} steps)`
	);
	lines.push("");
	for (const step of diff.steps) {
		lines.push(
			`  [${STATUS_MARK[step.status]}] ${step.stepId} ${step.label} (${step.replayElapsedMs}ms, ${step.elapsedDeltaMs >= 0 ? "+" : ""}${step.elapsedDeltaMs}ms)`
		);
		for (const target of step.targets) {
			if (target.status === "matched") continue;
			lines.push(`      ${target.description}`);
		}
		if (step.error) lines.push(`      error: ${step.error}`);
	}
	lines.push("");
	lines.push(
		`  Timing: baseline ${diff.timing.baselineDurationMs}ms → replay ${diff.timing.replayDurationMs}ms (${diff.timing.deltaMs >= 0 ? "+" : ""}${diff.timing.deltaMs}ms)`
	);
	for (const regression of diff.timing.regressions) {
		lines.push(
			`      ${regression.stepId} ${regression.label}: ${regression.baselineMs}ms → ${regression.replayMs}ms (×${regression.ratio.toFixed(2)})`
		);
	}
	lines.push(
		`  Editorial: cut ${diff.editorial.baselineTotalMs}ms → ${diff.editorial.projectedTotalMs}ms against a ${diff.editorial.limits.maxTotalMs}ms limit — ${diff.editorial.withinLimits ? "still holds" : "violated"}`
	);
	for (const issue of diff.editorial.issues) {
		lines.push(`      ${issue.code}: ${issue.message}`);
	}
	if (diff.refreshedProjectPath) {
		lines.push(`  Re-shot footage: ${diff.refreshedProjectPath}`);
	}
	for (const note of diff.notes) lines.push(`  note: ${note}`);
	return lines.join("\n");
}
