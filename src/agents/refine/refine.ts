/**
 * Refinement: note in, validated storyboard or a reason out.
 *
 * The contract is that a refinement never returns a storyboard the compiler would refuse. If the
 * edits produce one, the result is `rejected` and carries the rules that rejected it. It is never
 * quietly pulled back inside the limits — a user who asks for a four-second hold and is handed a
 * two-second one has been told nothing, and finds out at the render.
 */

import type { Storyboard } from "../runner/protocol";
import { applyEdits } from "./apply";
import { diffStoryboards } from "./diff";
import { type EditorialContext, carriedOverIssues, introducedIssues, validateEditorial } from "./editorial";
import { type EditInterpreter, type InterpretRequest, parseInterpreterOutput } from "./interpret";
import type { Edit, RefineIssue, RefinementOutcome } from "./types";

export interface ApplyRefinementOptions {
	context?: EditorialContext;
	/** Produce the diff and the verdict without committing: the result is `preview`. */
	dryRun?: boolean;
	/**
	 * `introduced` (the default) rejects only rules this edit broke or worsened, and reports rules
	 * the input already broke as `carriedOver`. `all` rejects any violation in the result, which is
	 * the compiler's own posture and the right setting when the storyboard must be clean before it
	 * is handed on.
	 */
	strictness?: "introduced" | "all";
}

function reasonFor(issues: RefineIssue[]): string {
	return issues.map((issue) => issue.message).join(" ");
}

/** Apply already-typed edits. Pure, synchronous, and the only path that mutates nothing. */
export function applyRefinement(
	storyboard: Storyboard,
	edits: Edit[],
	options: ApplyRefinementOptions = {}
): RefinementOutcome {
	const context = options.context ?? {};
	const strictness = options.strictness ?? "introduced";

	if (edits.length === 0) {
		return {
			status: "rejected",
			reason: "No edits to apply.",
			issues: [{ code: "no_edits", message: "No edits to apply." }],
			edits,
			diff: { changes: [] },
			clamps: [],
		};
	}

	const applied = applyEdits(storyboard, edits);
	const diff = diffStoryboards(storyboard, applied.storyboard);

	if (applied.issues.length > 0) {
		return {
			status: "rejected",
			reason: reasonFor(applied.issues),
			issues: applied.issues,
			edits,
			diff,
			clamps: applied.clamps,
		};
	}

	const before = validateEditorial(storyboard, context);
	const after = validateEditorial(applied.storyboard, context);
	const blocking = strictness === "all" ? after : introducedIssues(before, after);

	if (blocking.length > 0) {
		return {
			status: "rejected",
			reason: reasonFor(blocking),
			issues: blocking,
			edits,
			diff,
			clamps: applied.clamps,
		};
	}

	return {
		status: options.dryRun === true ? "preview" : "applied",
		storyboard: applied.storyboard,
		carriedOver: carriedOverIssues(before, after),
		edits,
		diff,
		clamps: applied.clamps,
	};
}

export interface RefineStoryboardInput extends ApplyRefinementOptions {
	storyboard: Storyboard;
	note: string;
	interpreter: EditInterpreter;
	beats?: InterpretRequest["beats"];
}

export async function refineStoryboard(input: RefineStoryboardInput): Promise<RefinementOutcome> {
	const request: InterpretRequest = {
		note: input.note,
		storyboard: input.storyboard,
		...(input.beats === undefined ? {} : { beats: input.beats }),
	};
	const context: EditorialContext = { ...(input.context ?? {}) };
	if (context.beats === undefined && input.beats !== undefined) context.beats = input.beats;

	const raw = await input.interpreter.interpret(request);
	const parsed = parseInterpreterOutput(raw);

	if (!parsed.ok) {
		const message = `The interpreter returned edits that do not typecheck: ${parsed.message ?? "unknown"}.`;
		return {
			status: "rejected",
			reason: message,
			issues: [{ code: "malformed_edits", message }],
			edits: [],
			diff: { changes: [] },
			clamps: [],
		};
	}

	if (parsed.edits.length === 0) {
		const message = `Nothing in "${input.note}" maps onto a supported edit.`;
		return {
			status: "rejected",
			reason: message,
			issues: [{ code: "uninterpretable_note", message }],
			edits: [],
			diff: { changes: [] },
			clamps: [],
		};
	}

	const options: ApplyRefinementOptions = { context };
	if (input.dryRun !== undefined) options.dryRun = input.dryRun;
	if (input.strictness !== undefined) options.strictness = input.strictness;
	return applyRefinement(input.storyboard, parsed.edits, options);
}
