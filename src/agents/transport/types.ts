/**
 * Transport abstraction for the runner gateway.
 *
 * Next.js App Router routes cannot host a WebSocket server, so the multiplexer owns no
 * sockets of its own: the socket layer is injected. Anything that can push a text frame
 * and be closed satisfies `RunnerSocket` — `ws`, a Cloudflare Durable Object, or a fake
 * in a unit test.
 */

export interface RunnerSocket {
	/** Push one text frame to the runner. Must not throw on a dead socket; report via `closed()`. */
	send(frame: string): void;
	close(code?: number, reason?: string): void;
}

/** Handle returned by `SessionMultiplexer.attach` — the socket layer drives these. */
export interface AttachedSocket {
	/** Feed one inbound text frame from the runner into the multiplexer. */
	receive(frame: string): void;
	/** Report that the underlying socket is gone. Idempotent. */
	disconnected(reason?: string): void;
	/** Resolves with the runner id once the handshake completes; rejects on mismatch or timeout. */
	readonly ready: Promise<string>;
}

export type TransportLogLevel = "debug" | "info" | "warn" | "error";

export type TransportLogger = (
	level: TransportLogLevel,
	message: string,
	meta?: Record<string, unknown>,
) => void;
