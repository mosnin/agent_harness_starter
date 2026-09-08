/**
 * Mapping between runner tool names and Director Protocol scopes.
 *
 * Capability tokens grant *tool names*; the runner re-checks *scopes*. This table is the
 * single place the two vocabularies meet, so a token minted for a run can never carry a tool
 * whose scope the user did not grant at pairing time.
 */

import type { Scope } from "./protocol";

export const RUNNER_TOOL_SCOPES = {
	runner_observe: "observe_screen",
	runner_list_windows: "observe_screen",
	runner_wait: "observe_screen",
	runner_move_pointer: "control_pointer",
	runner_click: "control_pointer",
	runner_drag: "control_pointer",
	runner_scroll: "control_pointer",
	runner_type_text: "control_keyboard",
	runner_key_press: "control_keyboard",
	runner_focus_app: "control_applications",
	runner_launch_app: "control_applications",
	runner_start_recording: "record",
	runner_stop_recording: "record",
	runner_apply_storyboard: "edit",
	runner_export: "export",
	runner_upload: "upload",
} as const satisfies Record<string, Scope>;

export type RunnerToolName = keyof typeof RUNNER_TOOL_SCOPES;

export const RUNNER_TOOL_NAMES = Object.keys(RUNNER_TOOL_SCOPES) as RunnerToolName[];

export function scopeForRunnerTool(toolName: string): Scope | undefined {
	return (RUNNER_TOOL_SCOPES as Record<string, Scope>)[toolName];
}

/** Every runner tool reachable with the given scopes. Absence of a scope is denial. */
export function runnerToolsForScopes(scopes: Iterable<Scope>): RunnerToolName[] {
	const granted = new Set(scopes);
	return RUNNER_TOOL_NAMES.filter((name) => granted.has(RUNNER_TOOL_SCOPES[name]));
}

/** The scopes a set of runner tools requires. Non-runner tool names are ignored. */
export function scopesForRunnerTools(tools: Iterable<string>): Scope[] {
	const scopes = new Set<Scope>();
	for (const tool of tools) {
		const scope = scopeForRunnerTool(tool);
		if (scope) scopes.add(scope);
	}
	return [...scopes].sort();
}
