/**
 * Regression verdict.
 *
 * The policy is a value, not a convention: whether drift fails the build is a decision a team
 * makes once and states, and the verdict carries the policy it was judged under so a red build
 * can be argued with. The default fails on breakage and on a cut that no longer fits its
 * editorial limits, and warns on drift — drift means the demo still works but the documentation
 * of it is stale, which is a ticket, not a broken pipeline.
 */

import type { ReplayDiff } from "./diff";

export type PolicyAction = "fail" | "warn" | "ignore";

export interface RegressionPolicy {
	/** A step that could not be resolved at all. */
	onBroken: PolicyAction;
	/** A step that resolved, but moved, was renamed, or came back by a weaker criterion. */
	onDrift: PolicyAction;
	/** The projected cut no longer satisfies the editorial limits. */
	onEditorial: PolicyAction;
	/** A step that got materially slower. */
	onTimingRegression: PolicyAction;
	/** Drifted steps allowed before drift is escalated to a failure regardless of `onDrift`. */
	maxDriftedSteps: number | null;
	/** Steps never attempted because an earlier one broke. */
	onSkipped: PolicyAction;
}

export const DEFAULT_REGRESSION_POLICY: RegressionPolicy = {
	onBroken: "fail",
	onDrift: "warn",
	onEditorial: "fail",
	onTimingRegression: "ignore",
	maxDriftedSteps: null,
	onSkipped: "warn",
};

/** Fails the build on drift too. For docs that are contractual rather than illustrative. */
export const STRICT_REGRESSION_POLICY: RegressionPolicy = {
	...DEFAULT_REGRESSION_POLICY,
	onDrift: "fail",
	onTimingRegression: "warn",
};

export type VerdictStatus = "pass" | "warn" | "fail";

export type FindingCode =
	| "steps_broken"
	| "steps_drifted"
	| "steps_skipped"
	| "editorial_violated"
	| "timing_regressed"
	| "drift_budget_exceeded";

export interface VerdictFinding {
	code: FindingCode;
	action: PolicyAction;
	message: string;
	stepIds: string[];
}

export interface RegressionVerdict {
	status: VerdictStatus;
	/** 0 for pass and warn, 1 for fail. Suitable as a CI process exit code. */
	exitCode: 0 | 1;
	policy: RegressionPolicy;
	findings: VerdictFinding[];
	summary: string;
}

function escalate(current: VerdictStatus, action: PolicyAction): VerdictStatus {
	if (action === "fail") return "fail";
	if (action === "warn" && current === "pass") return "warn";
	return current;
}

export function evaluateReplay(
	diff: ReplayDiff,
	policy: RegressionPolicy = DEFAULT_REGRESSION_POLICY
): RegressionVerdict {
	const findings: VerdictFinding[] = [];
	const stepsWith = (status: string) =>
		diff.steps.filter((step) => step.status === status).map((step) => step.stepId);

	const broken = stepsWith("broken");
	if (broken.length > 0 && policy.onBroken !== "ignore") {
		findings.push({
			code: "steps_broken",
			action: policy.onBroken,
			message: `${broken.length} step(s) could not be resolved; the flow no longer exists as recorded.`,
			stepIds: broken,
		});
	}

	const drifted = stepsWith("drifted");
	if (drifted.length > 0 && policy.onDrift !== "ignore") {
		findings.push({
			code: "steps_drifted",
			action: policy.onDrift,
			message: `${drifted.length} step(s) drifted; the flow still runs but the recorded footage is out of date.`,
			stepIds: drifted,
		});
	}
	if (policy.maxDriftedSteps !== null && drifted.length > policy.maxDriftedSteps) {
		findings.push({
			code: "drift_budget_exceeded",
			action: "fail",
			message: `${drifted.length} drifted step(s) exceeds the budget of ${policy.maxDriftedSteps}.`,
			stepIds: drifted,
		});
	}

	const skipped = stepsWith("skipped");
	if (skipped.length > 0 && policy.onSkipped !== "ignore") {
		findings.push({
			code: "steps_skipped",
			action: policy.onSkipped,
			message: `${skipped.length} step(s) were never attempted because an earlier step broke.`,
			stepIds: skipped,
		});
	}

	if (!diff.editorial.withinLimits && policy.onEditorial !== "ignore") {
		findings.push({
			code: "editorial_violated",
			action: policy.onEditorial,
			message: `The projected cut is ${diff.editorial.projectedTotalMs}ms against a ${diff.editorial.limits.maxTotalMs}ms limit: ${diff.editorial.issues.map((issue) => issue.message).join("; ")}`,
			stepIds: [],
		});
	}

	if (diff.timing.regressions.length > 0 && policy.onTimingRegression !== "ignore") {
		findings.push({
			code: "timing_regressed",
			action: policy.onTimingRegression,
			message: `${diff.timing.regressions.length} step(s) got materially slower.`,
			stepIds: diff.timing.regressions.map((regression) => regression.stepId),
		});
	}

	const status = findings.reduce<VerdictStatus>(
		(current, finding) => escalate(current, finding.action),
		"pass"
	);

	return {
		status,
		exitCode: status === "fail" ? 1 : 0,
		policy,
		findings,
		summary: `${status.toUpperCase()}: ${diff.summary.matched} matched, ${diff.summary.drifted} drifted, ${diff.summary.broken} broken, ${diff.summary.skipped} skipped`,
	};
}

export function describePolicy(policy: RegressionPolicy): string {
	const budget =
		policy.maxDriftedSteps === null ? "no budget" : `budget ${policy.maxDriftedSteps}`;
	return `breakage=${policy.onBroken}, drift=${policy.onDrift} (${budget}), editorial=${policy.onEditorial}, timing=${policy.onTimingRegression}, skipped=${policy.onSkipped}`;
}

export function renderVerdict(verdict: RegressionVerdict): string {
	const lines = [verdict.summary, `  policy: ${describePolicy(verdict.policy)}`];
	for (const finding of verdict.findings) {
		const scope = finding.stepIds.length > 0 ? ` [${finding.stepIds.join(", ")}]` : "";
		lines.push(`  ${finding.action}: ${finding.message}${scope}`);
	}
	if (verdict.findings.length === 0) lines.push("  nothing drifted, nothing broke.");
	return lines.join("\n");
}
