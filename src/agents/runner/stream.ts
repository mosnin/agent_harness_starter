/**
 * Resumable per-run event stream.
 *
 * A recording session runs for minutes, far longer than an HTTP connection reliably survives.
 * `RunStream` buffers the last N events with monotonic sequence numbers so a client that
 * reconnects with `Last-Event-ID` gets replayed from where it dropped instead of restarting.
 *
 * It is also the async push path the `pendingEvents` side-channel in `core.ts` is not:
 * `pendingEvents` only drains when the *next* SDK event arrives, so a runner progress update
 * that lands while the model is idle sits in that Map until the model happens to emit
 * something. Runner progress therefore goes through this stream, which wakes its consumers
 * immediately.
 */

import type { AgentEvent } from "../types";
import type { RunnerEvent } from "./protocol";

export interface SequencedEvent {
	seq: number;
	event: AgentEvent;
}

export interface RunStreamOptions {
	/** Events retained for replay. Older ones are dropped. Default 512. */
	bufferSize?: number;
}

export class RunStream {
	private readonly bufferSize: number;
	private buffer: SequencedEvent[] = [];
	private nextSeq = 0;
	private closed = false;
	private readonly waiters = new Set<() => void>();

	constructor(options: RunStreamOptions = {}) {
		this.bufferSize = options.bufferSize ?? 512;
	}

	get lastSeq(): number {
		return this.nextSeq - 1;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	push(event: AgentEvent): SequencedEvent | null {
		if (this.closed) return null;
		const sequenced: SequencedEvent = { seq: this.nextSeq++, event };
		this.buffer.push(sequenced);
		if (this.buffer.length > this.bufferSize) {
			this.buffer = this.buffer.slice(this.buffer.length - this.bufferSize);
		}
		this.wake();
		return sequenced;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.wake();
	}

	/** Events retained for replay after `afterSeq` (exclusive). */
	replay(afterSeq: number): SequencedEvent[] {
		return this.buffer.filter((e) => e.seq > afterSeq);
	}

	/**
	 * Replay everything after `afterSeq`, then follow live until the stream closes or the
	 * signal aborts. Pass `Last-Event-ID` as `afterSeq` to resume a dropped connection.
	 */
	async *subscribe(afterSeq = -1, signal?: AbortSignal): AsyncGenerator<SequencedEvent> {
		let cursor = afterSeq;
		while (true) {
			if (signal?.aborted) return;

			const pending = this.replay(cursor);
			if (pending.length > 0) {
				for (const item of pending) {
					cursor = item.seq;
					yield item;
				}
				// Re-check before sleeping: events can arrive while a yield is suspended, and
				// `wake` only reaches waiters that are already registered.
				continue;
			}

			if (this.closed) return;

			await this.wait(signal);
		}
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter();
		this.waiters.clear();
	}

	private wait(signal?: AbortSignal): Promise<void> {
		// An already-aborted signal never fires "abort" again, so check before registering.
		if (signal?.aborted) return Promise.resolve();
		return new Promise<void>((resolve) => {
			const done = () => {
				this.waiters.delete(done);
				signal?.removeEventListener("abort", done);
				resolve();
			};
			this.waiters.add(done);
			signal?.addEventListener("abort", done, { once: true });
		});
	}
}

/** Parse an SSE `Last-Event-ID` header into a replay cursor. */
export function parseLastEventId(header: string | null): number {
	if (!header) return -1;
	const parsed = Number.parseInt(header, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : -1;
}

/**
 * Project a runner event onto the harness `AgentEvent` union so runner progress reaches the
 * same SSE stream the model's own events use. Returns null for events with no UI meaning.
 */
export function runnerEventToAgentEvent(event: RunnerEvent): AgentEvent | null {
	switch (event.type) {
		case "progress":
			return {
				type: "progress",
				stage: event.stage,
				...(event.fraction !== undefined && event.fraction !== null
					? { fraction: event.fraction }
					: {}),
				...(event.detail !== undefined && event.detail !== null ? { detail: event.detail } : {}),
			};
		case "beatLogged":
			return { type: "progress", stage: "beat", detail: event.beat.label };
		case "approvalRequested":
			return {
				type: "approval_required",
				runId: event.sessionId,
				approvalId: event.approvalId,
				toolName: "runner_session",
				input: {},
				description: event.summary,
			};
		case "killSwitchEngaged":
			return {
				type: "error",
				error: "The user engaged the kill switch on the paired machine.",
				code: "RUNNER_KILL_SWITCH",
				remediation: "The runner has already stopped; treat the run as cancelled.",
			};
		case "sessionEnded":
			return event.reason === "completed"
				? { type: "progress", stage: "session_ended", detail: event.reason }
				: {
						type: "error",
						error: `Runner session ended: ${event.reason}.`,
						code: `RUNNER_SESSION_${event.reason.toUpperCase()}`,
					};
		case "heartbeat":
			return null;
	}
}
