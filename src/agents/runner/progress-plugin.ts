/**
 * withRunnerProgress — forwards a runner session's events into the agent's own event stream.
 *
 * HONEST LIMITATION: the `pendingEvents` Map that `core.ts` hands to `wrapTools` is drained
 * only when the *next* SDK event arrives (see the `for await (const event of result)` loop in
 * `core.ts`). It is a side-channel, not an async push. A `progress` update that lands while
 * the model is idle — exactly what happens during a multi-minute recording or export — sits
 * in that Map until the model happens to emit something. It is also keyed by id, so a second
 * update for the same key overwrites the first before either is delivered.
 *
 * Consequences, in order of preference:
 *   1. For live progress, subscribe to `RunnerGateway.stream(sessionId)` directly and serve it
 *      from `routes/runner/events/route.ts`. That is a true async push and it is resumable.
 *   2. Use this plugin only to fold runner progress into a transcript that is already being
 *      driven by model events, accepting that delivery is coalesced and arrives late.
 *
 * Fixing (1) inside `core.ts` would mean racing the SDK iterator against a queue — that is a
 * change to `core.ts`, which this team does not own. Left for integration.
 */

import type { AgentEvent, HarnessPlugin, PluginRunContext } from "../types";
import type { ToolDefinition } from "../tools/types";
import type { RunStream } from "./stream";

export interface RunnerProgressOptions {
	/** The session stream to forward. Usually `gateway.stream(sessionId)`. */
	stream: RunStream;
	/** Only these event types are forwarded. Default: progress and approval_required. */
	forward?: AgentEvent["type"][];
}

export function withRunnerProgress(options: RunnerProgressOptions): HarnessPlugin {
	const forward = new Set<AgentEvent["type"]>(
		options.forward ?? ["progress", "approval_required", "error"],
	);

	return {
		name: "runner-progress",

		wrapTools(
			tools: ToolDefinition[],
			_ctx: PluginRunContext,
			pendingEvents: Map<string, AgentEvent>,
		): ToolDefinition[] {
			void (async () => {
				for await (const { seq, event } of options.stream.subscribe(options.stream.lastSeq)) {
					if (forward.has(event.type)) pendingEvents.set(`runner-${seq}`, event);
				}
			})();
			return tools;
		},

		onComplete() {
			options.stream.close();
		},
	};
}
