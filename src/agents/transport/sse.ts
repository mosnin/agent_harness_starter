/**
 * SSE encoding for agent event streams.
 *
 * `lib/utils.ts#sseStream` takes an `AsyncGenerator<string>` and JSON-stringifies each chunk.
 * Routes that yielded already-stringified JSON therefore double-encoded: the wire carried
 * `data: "{\"type\":...}"`, a single `JSON.parse` on the client yielded a *string*, and
 * `event.type` was `undefined`. This helper takes the event objects themselves and encodes
 * exactly once.
 */

export interface SseStreamOptions {
	/** Emit `id:` lines so a reconnecting client can resume with `Last-Event-ID`. */
	withIds?: boolean;
	/** First id to emit when `withIds` is set. */
	startSeq?: number;
	/** Trailing sentinel. Set to null to omit. Default "[DONE]". */
	doneSentinel?: string | null;
}

/** Encode an async iterable of JSON-serializable events as an SSE body. */
export function sseEventStream<T>(
	source: AsyncIterable<T>,
	options: SseStreamOptions = {},
): ReadableStream<Uint8Array> {
	const { withIds = false, doneSentinel = "[DONE]" } = options;
	let seq = options.startSeq ?? 0;
	const encoder = new TextEncoder();

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				for await (const event of source) {
					const idLine = withIds ? `id: ${seq++}\n` : "";
					controller.enqueue(encoder.encode(`${idLine}data: ${JSON.stringify(event)}\n\n`));
				}
				if (doneSentinel !== null) {
					controller.enqueue(encoder.encode(`data: ${doneSentinel}\n\n`));
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: "error", error: message })}\n\n`),
				);
			} finally {
				controller.close();
			}
		},
	});
}

/** Encode one pre-sequenced SSE frame. Exported for tests and for resumable replay. */
export function sseFrame(event: unknown, id?: number): string {
	const idLine = id === undefined ? "" : `id: ${id}\n`;
	return `${idLine}data: ${JSON.stringify(event)}\n\n`;
}
