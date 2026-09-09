/**
 * Injection screening for screen-derived content.
 *
 * The vocabulary is the one already in `src/agents/guardrails/injection.ts`: that detector runs
 * first, unchanged, over every screen segment. On top of it sit the patterns specific to this
 * channel — text that addresses an agent, names the agent's own tools or scopes, redefines the
 * task, or leans on urgency and authority to skip the human.
 *
 * Two properties matter more than coverage. Nothing is dropped: a suspicious segment is reported
 * with its locator so a human can see the attack, because silently deleting it hides an attack in
 * progress. And screening fails closed: a screener that throws returns `unknown`, which the policy
 * treats exactly like a detected injection.
 */

import { promptInjectionGuardrail, severityOf } from "../guardrails/injection";
import type { ThreatSeverity, ThreatType } from "../guardrails/injection";
import { unwrapUntrusted, untrustedFromScreen } from "./untrusted";
import type { ScreenTextSource, UntrustedOrigin, UntrustedText } from "./untrusted";

export type ScreenThreatType =
	| ThreatType
	| "agent_directed_command"
	| "tool_or_scope_reference"
	| "task_redefinition"
	| "authority_pressure";

export type ScreenVerdict = "clean" | "suspicious" | "hostile" | "unknown";

export interface ScreenInjectionFinding {
	type: ScreenThreatType;
	confidence: number;
	severity: ThreatSeverity;
	origin: UntrustedOrigin;
	/** Neutralised, truncated copy of the offending text, for logs and the human review surface. */
	preview: string;
	/** The offending segment, still wrapped. Render it, never concatenate it. */
	content: UntrustedText;
}

export interface ScreenAssessment {
	verdict: ScreenVerdict;
	/** Highest finding confidence; 0 when nothing matched, 1 when screening itself failed. */
	confidence: number;
	severity: ThreatSeverity;
	findings: ScreenInjectionFinding[];
	/** Locators that produced at least one finding. */
	suspectLocators: string[];
	segmentsScreened: number;
	/** Set only when screening threw. The verdict is then `unknown` and must be treated as unsafe. */
	error?: string;
}

export interface ScreenPattern {
	pattern: RegExp;
	type: ScreenThreatType;
	confidence: number;
}

export interface ScreenScreeningOptions {
	/** Confidence at or above which a finding makes the screen hostile. Default 0.85. */
	hostileThreshold?: number;
	/** Confidence at or above which a finding makes the screen suspicious. Default 0.6. */
	suspiciousThreshold?: number;
	/** Extra deployment-specific patterns. */
	additionalPatterns?: ScreenPattern[];
	/** Characters of a segment fed to the matchers. Default 8000. */
	maxSegmentChars?: number;
	/** Segments screened per observation. Default 400. */
	maxSegments?: number;
	/** Characters kept in a finding preview. Default 180. */
	previewChars?: number;
}

// ── Channel-specific patterns ─────────────────────────────────────────────────
//
// Every pattern requires instruction shape or agent addressing. None fires on a destructive verb
// alone: "Delete Account" on a button is a product, not an attack, and a screener that cannot tell
// the difference cannot be left switched on.

const AGENT = "(?:ai|a\\.i\\.|agent|assistant|chatbot|copilot|bot|llm|language\\s+model|claude|chatgpt|gpt)";
const DO = "(?:click|press|tap|open|launch|type|enter|input|navigate|go\\s+to|select|choose|delete|remove|erase|download|install|run|execute|send|email|share|upload|export|approve|confirm|accept|purchase|buy|pay|transfer|disable|revoke)";

const SCREEN_PATTERNS: ScreenPattern[] = [
	{
		pattern: /\b(?:ignore|disregard|forget|discard|override)\s+(?:all\s+|any\s+)?(?:your|the|my)?\s*(?:previous|prior|earlier|above|preceding|last|original|system)?\s*(?:instructions?|prompts?|rules?|directives?|guidelines?|orders?|constraints?)\b/i,
		type: "instruction_override",
		confidence: 0.9,
	},
	{
		pattern: new RegExp(
			`\\b${AGENT}\\b[^.!?\\n]{0,40}?\\b(?:please\\s+)?(?:you\\s+(?:must|should|need\\s+to|will|have\\s+to)\\s+)?(?:now\\s+)?${DO}\\b`,
			"i"
		),
		type: "agent_directed_command",
		confidence: 0.85,
	},
	{
		pattern: new RegExp(`\\b(?:hey|hi|dear|attention|note\\s+to|message\\s+for)\\s+${AGENT}\\b`, "i"),
		type: "agent_directed_command",
		confidence: 0.8,
	},
	{
		pattern: new RegExp(`\\bif\\s+you\\s+(?:are|'re)\\s+(?:an?\\s+)?(?:${AGENT}|automated|reading\\s+this)\\b`, "i"),
		type: "agent_directed_command",
		confidence: 0.9,
	},
	{
		pattern: new RegExp(
			`\\b(?:automated\\s+)?(?:${AGENT})s?\\s+(?:must|should|are\\s+required\\s+to|need\\s+to|are\\s+instructed\\s+to)\\s+\\w+`,
			"i"
		),
		type: "agent_directed_command",
		confidence: 0.8,
	},
	{
		pattern: /\b(?:control_pointer|control_keyboard|control_applications|observe_screen|cap_act|cap_observe|cap_export|session\s+lease|capability\s+token)\b/i,
		type: "tool_or_scope_reference",
		confidence: 0.85,
	},
	{
		pattern: /\b(?:grant|escalate|elevate|expand|request)\s+(?:yourself|your\s+own|(?:additional|more|full|extra|elevated|broader)\s+)\s*(?:scopes?|permissions?|privileges?|access\s+rights?)\b/i,
		type: "tool_or_scope_reference",
		confidence: 0.85,
	},
	{
		pattern: /\b(?:use|invoke|call)\s+(?:the\s+)?(?:\w+\s+)?(?:tool|function)\s+(?:to|and|named|called)\b/i,
		type: "tool_or_scope_reference",
		confidence: 0.7,
	},
	{
		pattern: /\byour\s+(?:new|real|actual|updated|true)\s+(?:task|goal|objective|mission|instructions?|assignment)\b/i,
		type: "task_redefinition",
		confidence: 0.9,
	},
	{
		pattern: new RegExp(
			`\\b(?:before|instead\\s+of)\\s+(?:you\\s+)?(?:continu\\w+|proceed\\w*|finish\\w*|the\\s+(?:above|previous|current|original)\\s+(?:task|step|instruction)s?)\\b[^.!?\\n]{0,60}?\\b${DO}\\b`,
			"i"
		),
		type: "task_redefinition",
		confidence: 0.85,
	},
	{
		pattern: /\b(?:the\s+)?(?:demo|recording|session|task|shoot)\s+(?:has\s+)?(?:been\s+)?(?:cancelled|canceled|changed|updated|superseded)\b[^.!?\n]{0,60}?\b(?:instead|now|new)\b/i,
		type: "task_redefinition",
		confidence: 0.8,
	},
	{
		pattern: /\bdo\s*n[o']?t\s+(?:tell|inform|notify|report\s+to|mention\s+this\s+to|show\s+this\s+to)\s+(?:the\s+)?(?:user|human|operator|owner)\b/i,
		type: "task_redefinition",
		confidence: 0.9,
	},
	{
		pattern: /\b(?:without|do\s*n[o']?t|never|no\s+need\s+to)\s+(?:ask(?:ing)?|prompt(?:ing)?|wait(?:ing)?\s+for|seek(?:ing)?|request(?:ing)?)\s+(?:for\s+)?(?:the\s+)?(?:user|human|operator|owner)\b/i,
		type: "authority_pressure",
		confidence: 0.9,
	},
	{
		pattern: /\bskip\s+(?:the\s+)?(?:confirmation|approval|verification|consent|review)\s+(?:step|dialog|screen|prompt)?\b/i,
		type: "authority_pressure",
		confidence: 0.8,
	},
	{
		pattern: /\b(?:without|do\s*n[o']?t|no\s+need\s+to)\s+(?:ask(?:ing)?|wait(?:ing)?\s+for|request(?:ing)?)\s+(?:for\s+)?(?:approval|confirmation|permission)\b/i,
		type: "authority_pressure",
		confidence: 0.45,
	},
	{
		pattern: /\b(?:authoriz|authoris|approv)(?:ed|al)\s+by\s+(?:the\s+)?(?:administrator|admin|owner|security\s+team|it\s+department|system)\b/i,
		type: "authority_pressure",
		confidence: 0.75,
	},
	{
		pattern: /\bthis\s+is\s+(?:an?\s+)?(?:official|authorized|authorised|system|automated)\s+(?:message|instruction|notice|request|directive)\b/i,
		type: "authority_pressure",
		confidence: 0.8,
	},
	{
		pattern: new RegExp(`\\b(?:urgent(?:ly)?|immediately|right\\s+now|asap|as\\s+soon\\s+as\\s+possible)\\b[^.!?\\n]{0,40}?\\b${DO}\\b`, "i"),
		type: "authority_pressure",
		confidence: 0.7,
	},
];

/**
 * Instruction-shaped text is normal in a document and anomalous in a button label or a window
 * title, so the same sentence weighs more when it arrives through a control's title or value.
 */
const PROSE_ROLES = new Set([
	"AXStaticText",
	"AXTextArea",
	"AXWebArea",
	"AXGroup",
	"AXDocument",
	"AXScrollArea",
	"AXHeading",
	"AXParagraph",
]);

function channelWeight(origin: UntrustedOrigin): number {
	if (origin.channel === "window_title") return 0.1;
	if (origin.channel === "element_identifier") return 0.05;
	if (origin.role && PROSE_ROLES.has(origin.role)) return 0;
	return 0.1;
}

// ── Base detector ─────────────────────────────────────────────────────────────

interface BaseMatch {
	type: ThreatType;
	adjusted: number;
}

/**
 * The existing guardrail owns the base pattern set and it is not exported, so the detector is
 * driven through its public factory with the block threshold lifted out of reach and the warn
 * threshold dropped to zero: every match then lands in the context metadata instead of throwing.
 * A throw is still handled, and still counts as a detection.
 */
const baseGuardrail = promptInjectionGuardrail({
	blockThreshold: Number.POSITIVE_INFINITY,
	warnThreshold: 0,
});

function runBaseDetector(text: string): BaseMatch[] {
	const meta: Record<string, unknown> = {};
	try {
		baseGuardrail.check(text, { agentName: "screen-injection-screener", meta });
	} catch {
		return [{ type: "indirect_injection", adjusted: 1 }];
	}
	const warning = meta.promptInjectionWarning as
		| { matches?: Array<{ type: ThreatType; adjusted: number }> }
		| undefined;
	return (warning?.matches ?? []).map((m) => ({ type: m.type, adjusted: m.adjusted }));
}

// ── Screening ─────────────────────────────────────────────────────────────────

function preview(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function screenSegment(
	item: UntrustedText,
	patterns: ScreenPattern[],
	options: Required<Pick<ScreenScreeningOptions, "maxSegmentChars" | "previewChars">>
): ScreenInjectionFinding[] {
	const text = unwrapUntrusted(item).slice(0, options.maxSegmentChars);
	const raw: Array<{ type: ScreenThreatType; confidence: number }> = [];

	for (const match of runBaseDetector(text)) {
		raw.push({ type: match.type, confidence: match.adjusted });
	}
	for (const { pattern, type, confidence } of patterns) {
		if (pattern.test(text)) raw.push({ type, confidence });
	}
	if (raw.length === 0) return [];

	const distinctTypes = new Set(raw.map((m) => m.type)).size;
	const corroboration = 0.08 * (distinctTypes - 1);
	const weight = channelWeight(item.origin);

	return raw.map(({ type, confidence }) => {
		const adjusted = Math.min(1, confidence + corroboration + weight);
		return {
			type,
			confidence: adjusted,
			severity: severityOf(adjusted),
			origin: item.origin,
			preview: preview(text, options.previewChars),
			content: item,
		};
	});
}

function assess(
	findings: ScreenInjectionFinding[],
	segmentsScreened: number,
	hostileThreshold: number,
	suspiciousThreshold: number
): ScreenAssessment {
	if (findings.length === 0) {
		return {
			verdict: "clean",
			confidence: 0,
			severity: "low",
			findings: [],
			suspectLocators: [],
			segmentsScreened,
		};
	}
	const sorted = [...findings].sort((a, b) => b.confidence - a.confidence);
	const confidence = sorted[0].confidence;
	const verdict: ScreenVerdict =
		confidence >= hostileThreshold
			? "hostile"
			: confidence >= suspiciousThreshold
				? "suspicious"
				: "clean";
	return {
		verdict,
		confidence,
		severity: severityOf(confidence),
		findings: sorted,
		suspectLocators: [...new Set(sorted.map((f) => f.origin.locator))],
		segmentsScreened,
	};
}

/** The assessment returned when screening could not complete. Unsafe by construction. */
export function screeningUnavailable(error: unknown, segmentsScreened = 0): ScreenAssessment {
	return {
		verdict: "unknown",
		confidence: 1,
		severity: "critical",
		findings: [],
		suspectLocators: [],
		segmentsScreened,
		error: error instanceof Error ? error.message : String(error),
	};
}

/** Screen already-extracted segments. Never throws: a failure becomes an `unknown` verdict. */
export function screenUntrustedSegments(
	segments: readonly UntrustedText[],
	options: ScreenScreeningOptions = {}
): ScreenAssessment {
	try {
		const hostileThreshold = options.hostileThreshold ?? 0.85;
		const suspiciousThreshold = options.suspiciousThreshold ?? 0.6;
		const patterns = [...SCREEN_PATTERNS, ...(options.additionalPatterns ?? [])];
		const limits = {
			maxSegmentChars: options.maxSegmentChars ?? 8000,
			previewChars: options.previewChars ?? 180,
		};
		const considered = segments.slice(0, options.maxSegments ?? 400);
		const findings = considered.flatMap((item) => screenSegment(item, patterns, limits));
		return assess(findings, considered.length, hostileThreshold, suspiciousThreshold);
	} catch (error) {
		return screeningUnavailable(error, segments.length);
	}
}

/** Screen an observation: extract every attacker-controlled string, then screen all of them. */
export function screenObservation(
	source: ScreenTextSource,
	options: ScreenScreeningOptions = {}
): ScreenAssessment {
	try {
		return screenUntrustedSegments(untrustedFromScreen(source), options);
	} catch (error) {
		return screeningUnavailable(error);
	}
}

/** True when the assessment must not be allowed to authorise an intrusive action. */
export function assessmentIsUnsafe(assessment: ScreenAssessment): boolean {
	return assessment.verdict === "hostile" || assessment.verdict === "unknown";
}

/** One line per finding, for an operator-facing log or an escalation payload. */
export function describeAssessment(assessment: ScreenAssessment): string {
	if (assessment.verdict === "unknown") {
		return `Screen screening failed (${assessment.error ?? "unknown error"}); treating the screen as hostile.`;
	}
	if (assessment.findings.length === 0) {
		return `No injection indicators across ${assessment.segmentsScreened} screen segments.`;
	}
	const lines = assessment.findings
		.slice(0, 10)
		.map((f) => `  ${f.origin.locator} [${f.type} ${f.confidence.toFixed(2)}] ${f.preview}`);
	return [
		`${assessment.verdict} screen (${assessment.confidence.toFixed(2)}) across ${assessment.segmentsScreened} segments:`,
		...lines,
	].join("\n");
}
