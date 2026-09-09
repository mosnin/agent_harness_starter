/**
 * The one place that decides what a screening assessment means for a pending action.
 *
 * Both enforcement points call this: the governance rules in `governance/desktop-policy.ts`, which
 * run when a plugin wraps the tool, and the operator loop in `definitions/director.ts`, which runs
 * always — `src/agents/orchestrator.ts` never calls `wrapTools`, so a plugin-only defence is not a
 * defence. Sharing the predicate is what keeps the two paths from drifting into different answers
 * about the same screen.
 *
 * Scope intrusiveness comes from `runner/protocol.ts`, which mirrors `Scope::is_intrusive` in the
 * Rust contract: pointer, keyboard, applications, upload.
 */

import { isIntrusiveScope } from "../runner/protocol";
import type { Scope } from "../runner/protocol";
import type { RiskLevel } from "../governance/types";
import { assessmentIsUnsafe } from "./screen-injection";
import type { ScreenAssessment } from "./screen-injection";
import type { ActionProvenance } from "./provenance";

export type ScreenSafetyOutcome = "allow" | "flag" | "block";

export type ScreenSafetyReason =
	| "clean"
	| "screen_injection_intrusive_scope"
	| "screening_unavailable"
	| "screen_derived_justification"
	| "screen_injection_observed"
	| "screen_content_suspicious";

export interface ScreenSafetyDecision {
	outcome: ScreenSafetyOutcome;
	reason: ScreenSafetyReason;
	description: string;
	risk: RiskLevel;
	/** Whether a human must be told now, not in a report later. */
	escalate: boolean;
	intrusive: boolean;
	suspectLocators: string[];
}

export interface ScreenSafetyInput {
	assessment: ScreenAssessment;
	/** Scopes the pending action needs. Empty means nothing is pending — observation only. */
	scopes: readonly Scope[];
	provenance?: ActionProvenance;
	/** True when a human approved this specific step, or is otherwise gating it. */
	attended?: boolean;
	/**
	 * Require approval for any action whose justification traces to screen text, not only to
	 * flagged screen text. Safer and noisier; off by default. Default false.
	 */
	strictProvenance?: boolean;
}

const allow = (description: string): ScreenSafetyDecision => ({
	outcome: "allow",
	reason: "clean",
	description,
	risk: "low",
	escalate: false,
	intrusive: false,
	suspectLocators: [],
});

export function evaluateScreenSafety(input: ScreenSafetyInput): ScreenSafetyDecision {
	const { assessment, provenance } = input;
	const intrusive = input.scopes.some(isIntrusiveScope);
	const suspectLocators = assessment.suspectLocators;

	if (intrusive && assessment.verdict === "unknown") {
		return {
			outcome: "block",
			reason: "screening_unavailable",
			description: `Screen content could not be screened (${assessment.error ?? "unknown error"}), so it cannot be trusted to justify an intrusive action.`,
			risk: "critical",
			escalate: true,
			intrusive,
			suspectLocators,
		};
	}

	if (intrusive && assessment.verdict === "hostile") {
		return {
			outcome: "block",
			reason: "screen_injection_intrusive_scope",
			description: `Prompt injection detected in screen content (confidence ${assessment.confidence.toFixed(2)}) at ${suspectLocators.join(", ")}; the pending action holds an intrusive scope.`,
			risk: "critical",
			escalate: true,
			intrusive,
			suspectLocators,
		};
	}

	if (intrusive && !input.attended && provenance) {
		const traced =
			provenance.instructionFollowing ||
			(input.strictProvenance === true && provenance.screenDerived);
		if (traced) {
			const locators = provenance.instructionFollowing
				? provenance.suspectLocators
				: provenance.locators;
			return {
				outcome: "block",
				reason: "screen_derived_justification",
				description: `The action's justification traces to screen text (${locators.join(", ")}); an intrusive scope may not run on screen-derived reasoning without a human.`,
				risk: "critical",
				escalate: true,
				intrusive,
				suspectLocators: locators,
			};
		}
	}

	if (assessmentIsUnsafe(assessment)) {
		return {
			outcome: "flag",
			reason: "screen_injection_observed",
			description:
				assessment.verdict === "unknown"
					? `Screen content could not be screened (${assessment.error ?? "unknown error"}); no intrusive scope is pending, so the run continues under watch.`
					: `Prompt injection detected in screen content (confidence ${assessment.confidence.toFixed(2)}) at ${suspectLocators.join(", ")}; no intrusive scope is pending.`,
			risk: "high",
			escalate: false,
			intrusive,
			suspectLocators,
		};
	}

	if (assessment.verdict === "suspicious") {
		return {
			outcome: "flag",
			reason: "screen_content_suspicious",
			description: `Screen content shows weak injection indicators (confidence ${assessment.confidence.toFixed(2)}) at ${suspectLocators.join(", ")}.`,
			risk: "medium",
			escalate: false,
			intrusive,
			suspectLocators,
		};
	}

	return { ...allow("No injection indicators in screen content."), intrusive };
}
