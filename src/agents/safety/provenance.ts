/**
 * Why the agent chose an action.
 *
 * A justification that echoes the operator's brief is the agent doing its job. A justification
 * that echoes text the screener flagged is the agent repeating an attacker's words back as its own
 * reason — that is what `instructionFollowing` marks, and it is the fact the policy enforces on.
 *
 * Echoing *unflagged* screen text ("click the Continue button") is normal and is recorded as
 * `screenDerived` without being treated as an attack; blocking it would block every legitimate
 * step. Deployments that want the stricter reading turn it on in the policy instead.
 */

import { unwrapUntrusted } from "./untrusted";
import type { UntrustedText } from "./untrusted";
import type { ScreenInjectionFinding } from "./screen-injection";

export type ProvenanceSource = "operator_brief" | "screen" | "mixed" | "unknown";

export interface ActionProvenance {
	source: ProvenanceSource;
	/** The justification repeats text that came from the screen. */
	screenDerived: boolean;
	/** The justification repeats screen text the screener flagged. */
	instructionFollowing: boolean;
	/** Screen locators the justification echoes. */
	locators: string[];
	/** Of those, the ones the screener flagged. */
	suspectLocators: string[];
	/** Share of the justification's distinctive words that also appear in the operator's brief. */
	briefOverlap: number;
	/** Share of the justification's distinctive words that appear only on screen. */
	screenOverlap: number;
}

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "for", "to", "of", "in", "on", "at", "by", "with",
	"from", "into", "then", "than", "that", "this", "these", "those", "it", "its", "is", "are",
	"was", "were", "be", "been", "being", "as", "so", "if", "not", "no", "do", "does", "did",
	"can", "will", "would", "should", "must", "may", "i", "you", "we", "they", "he", "she",
	"my", "your", "our", "their", "next", "now", "here", "there", "step", "click", "clicking",
	"open", "opening", "type", "typing", "press", "pressing", "select", "selecting", "button",
	"screen", "window", "element", "page", "app", "application", "user", "because", "since",
	"after", "before", "again", "still", "one", "two", "first", "last", "current",
]);

/**
 * Enough stemming to stop "export" and "exporting" from being read as different words: an agent
 * paraphrases the brief, and a provenance check that misses the paraphrase attributes the agent's
 * own words to the screen.
 */
function stem(word: string): string {
	if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
	if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
	if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
	return word;
}

function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
		if (raw.length < 3) continue;
		if (STOPWORDS.has(raw)) continue;
		const stemmed = stem(raw);
		if (STOPWORDS.has(stemmed)) continue;
		out.add(stemmed);
	}
	return out;
}

export interface ProvenanceInput {
	/** The agent's stated reason for this action. */
	rationale?: string | null;
	/** The operator's brief: the goal the human actually asked for. */
	brief: string;
	/** Screen segments in scope for the decision. */
	segments: readonly UntrustedText[];
	/** Findings from screening those segments. */
	findings?: readonly ScreenInjectionFinding[];
}

/**
 * Trace a decision's justification back to where its words came from. Purely lexical, so it is
 * cheap, deterministic and cannot be talked out of a verdict — and correspondingly it only sees
 * an agent that quotes; see the module note on what it misses.
 */
export function traceActionProvenance(input: ProvenanceInput): ActionProvenance {
	const rationale = (input.rationale ?? "").trim();
	if (rationale.length === 0) {
		return {
			source: "unknown",
			screenDerived: false,
			instructionFollowing: false,
			locators: [],
			suspectLocators: [],
			briefOverlap: 0,
			screenOverlap: 0,
		};
	}

	const rationaleTokens = tokens(rationale);
	const briefTokens = tokens(input.brief);
	const fromBrief = [...rationaleTokens].filter((t) => briefTokens.has(t));
	const novel = new Set([...rationaleTokens].filter((t) => !briefTokens.has(t)));
	const flagged = new Set((input.findings ?? []).map((f) => f.origin.locator));

	const locators: string[] = [];
	const matchedNovel = new Set<string>();
	for (const segment of input.segments) {
		const segmentTokens = tokens(unwrapUntrusted(segment));
		if (segmentTokens.size === 0) continue;
		const shared = [...segmentTokens].filter((t) => novel.has(t));
		const echoed = shared.length >= 2 || (shared.length === 1 && segmentTokens.size <= 3);
		if (!echoed) continue;
		locators.push(segment.origin.locator);
		for (const token of shared) matchedNovel.add(token);
	}

	const unique = [...new Set(locators)];
	const suspectLocators = unique.filter((locator) => flagged.has(locator));
	const denominator = rationaleTokens.size || 1;
	const briefOverlap = fromBrief.length / denominator;
	const screenOverlap = matchedNovel.size / denominator;
	const screenDerived = unique.length > 0;

	const source: ProvenanceSource = screenDerived
		? briefOverlap > 0
			? "mixed"
			: "screen"
		: briefOverlap > 0
			? "operator_brief"
			: "unknown";

	return {
		source,
		screenDerived,
		instructionFollowing: suspectLocators.length > 0,
		locators: unique,
		suspectLocators,
		briefOverlap,
		screenOverlap,
	};
}

/** A short line for the run outcome, so a screen-derived step is visible without reading metadata. */
export function describeProvenance(provenance: ActionProvenance): string {
	if (provenance.source === "unknown") return "provenance: unknown (no rationale recorded)";
	if (provenance.instructionFollowing) {
		return `provenance: SCREEN-DERIVED and traced to flagged text (${provenance.suspectLocators.join(", ")})`;
	}
	if (provenance.screenDerived) {
		return `provenance: ${provenance.source}, echoes ${provenance.locators.join(", ")}`;
	}
	return "provenance: operator brief";
}
