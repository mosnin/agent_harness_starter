/**
 * Transport-agnostic session multiplexer.
 *
 * Pure logic: connection registry, request/reply correlation by envelope `id`, per-command
 * timeouts, event fan-out and heartbeat liveness. It never opens a socket — see
 * `ws-node-server.ts` for the standalone Node binding and `runner/gateway.ts` for the
 * authorization layer above it.
 */

import { AgentError } from "../errors";
import {
	type Command,
	type CommandResult,
	type Envelope,
	PROTOCOL_MAJOR,
	PROTOCOL_VERSION,
	type ProtocolError,
	type RunnerEvent,
	type RunnerInfo,
	parseEnvelopeFrame,
	protocolError,
	protocolMajor,
} from "../runner/protocol";
import type { AttachedSocket, RunnerSocket, TransportLogger } from "./types";

export class RunnerTransportError extends AgentError {
	readonly protocol: ProtocolError;

	constructor(protocol: ProtocolError) {
		super(protocol.message, `RUNNER_${protocol.code.toUpperCase()}`, protocol.remediation ?? undefined);
		this.name = "RunnerTransportError";
		this.protocol = protocol;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface MultiplexerOptions {
	/** Per-command reply deadline. Default 30s. */
	commandTimeoutMs?: number;
	/** Deadline for a freshly attached socket to answer the handshake. Default 10s. */
	handshakeTimeoutMs?: number;
	/** A connection silent for longer than this is considered dead by `sweepIdle`. Default 45s. */
	heartbeatTimeoutMs?: number;
	now?: () => number;
	newId?: () => string;
	logger?: TransportLogger;
}

export interface ConnectionSnapshot {
	runnerId: string;
	info: RunnerInfo;
	connectedAt: number;
	lastSeenAt: number;
	inFlight: number;
}

export interface RunnerEventPayload {
	runnerId: string;
	event: RunnerEvent;
}

export interface DisconnectPayload {
	runnerId: string;
	reason: string;
}

export interface SendOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

type PendingCommand = {
	resolve: (result: CommandResult) => void;
	reject: (err: RunnerTransportError) => void;
	timer: ReturnType<typeof setTimeout>;
	onAbort?: () => void;
	signal?: AbortSignal;
};

type Connection = {
	socket: RunnerSocket;
	runnerId: string | null;
	info: RunnerInfo | null;
	connectedAt: number;
	lastSeenAt: number;
	handshakeId: string;
	pending: Map<string, PendingCommand>;
	settleHandshake: (runnerId: string) => void;
	failHandshake: (err: RunnerTransportError) => void;
	handshakeTimer: ReturnType<typeof setTimeout> | null;
	dead: boolean;
};

const DEFAULTS = {
	commandTimeoutMs: 30_000,
	handshakeTimeoutMs: 10_000,
	heartbeatTimeoutMs: 45_000,
};

export class SessionMultiplexer {
	private readonly opts: Required<Omit<MultiplexerOptions, "logger">> & { logger: TransportLogger };
	private readonly connections = new Set<Connection>();
	private readonly byRunner = new Map<string, Connection>();
	private readonly eventListeners = new Set<(payload: RunnerEventPayload) => void>();
	private readonly connectListeners = new Set<(snapshot: ConnectionSnapshot) => void>();
	private readonly disconnectListeners = new Set<(payload: DisconnectPayload) => void>();

	constructor(options: MultiplexerOptions = {}) {
		this.opts = {
			commandTimeoutMs: options.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs,
			handshakeTimeoutMs: options.handshakeTimeoutMs ?? DEFAULTS.handshakeTimeoutMs,
			heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULTS.heartbeatTimeoutMs,
			now: options.now ?? (() => Date.now()),
			newId: options.newId ?? (() => globalThis.crypto.randomUUID()),
			logger: options.logger ?? (() => {}),
		};
	}

	/**
	 * Register a freshly opened socket and immediately drive the protocol handshake.
	 * The connection is not addressable by runner id until the handshake succeeds, so a
	 * runner that never answers can never receive a command.
	 */
	attach(socket: RunnerSocket): AttachedSocket {
		const now = this.opts.now();
		let settleHandshake: (runnerId: string) => void = () => {};
		let failHandshake: (err: RunnerTransportError) => void = () => {};

		const ready = new Promise<string>((resolve, reject) => {
			settleHandshake = resolve;
			failHandshake = reject;
		});
		ready.catch(() => {});

		const conn: Connection = {
			socket,
			runnerId: null,
			info: null,
			connectedAt: now,
			lastSeenAt: now,
			handshakeId: this.opts.newId(),
			pending: new Map(),
			settleHandshake,
			failHandshake,
			handshakeTimer: null,
			dead: false,
		};
		this.connections.add(conn);

		conn.handshakeTimer = setTimeout(() => {
			this.kill(
				conn,
				protocolError(
					"protocol_version_mismatch",
					`Runner did not complete the handshake within ${this.opts.handshakeTimeoutMs}ms.`,
				),
			);
		}, this.opts.handshakeTimeoutMs);

		this.write(conn, {
			kind: "command",
			id: conn.handshakeId,
			token: "",
			command: { type: "handshake", protocol_version: PROTOCOL_VERSION },
		});

		return {
			ready,
			receive: (frame: string) => this.receive(conn, frame),
			disconnected: (reason?: string) =>
				this.kill(conn, protocolError("internal", reason ?? "Runner connection closed.")),
		};
	}

	/** Send a command to a connected runner and await its reply. */
	async send(
		runnerId: string,
		command: Command,
		token: string,
		options: SendOptions = {},
	): Promise<CommandResult> {
		const conn = this.byRunner.get(runnerId);
		if (!conn || conn.dead) {
			throw new RunnerTransportError(
				protocolError(
					"internal",
					`Runner "${runnerId}" is not connected.`,
					"Ask the user to start the cap-runner daemon on the paired Mac.",
				),
			);
		}

		const id = this.opts.newId();
		const timeoutMs = options.timeoutMs ?? this.opts.commandTimeoutMs;

		return new Promise<CommandResult>((resolve, reject) => {
			if (options.signal?.aborted) {
				reject(new RunnerTransportError(protocolError("internal", "Command aborted before dispatch.")));
				return;
			}

			const timer = setTimeout(() => {
				conn.pending.delete(id);
				cleanup();
				reject(
					new RunnerTransportError(
						protocolError(
							"internal",
							`Runner "${runnerId}" did not reply to "${command.type}" within ${timeoutMs}ms.`,
						),
					),
				);
			}, timeoutMs);

			const onAbort = () => {
				conn.pending.delete(id);
				clearTimeout(timer);
				cleanup();
				reject(new RunnerTransportError(protocolError("internal", "Command aborted by caller.")));
			};

			const cleanup = () => {
				options.signal?.removeEventListener("abort", onAbort);
			};

			options.signal?.addEventListener("abort", onAbort, { once: true });

			conn.pending.set(id, {
				resolve: (result) => {
					cleanup();
					resolve(result);
				},
				reject: (err) => {
					cleanup();
					reject(err);
				},
				timer,
				onAbort,
				signal: options.signal,
			});

			this.write(conn, { kind: "command", id, token, command });
		});
	}

	isConnected(runnerId: string): boolean {
		const conn = this.byRunner.get(runnerId);
		return Boolean(conn && !conn.dead);
	}

	connection(runnerId: string): ConnectionSnapshot | null {
		const conn = this.byRunner.get(runnerId);
		return conn && conn.info && conn.runnerId ? snapshot(conn) : null;
	}

	listConnections(): ConnectionSnapshot[] {
		return [...this.byRunner.values()].filter((c) => c.info && c.runnerId).map(snapshot);
	}

	disconnect(runnerId: string, reason = "Disconnected by control plane."): void {
		const conn = this.byRunner.get(runnerId);
		if (conn) this.kill(conn, protocolError("internal", reason));
	}

	onEvent(listener: (payload: RunnerEventPayload) => void): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onConnect(listener: (snapshot: ConnectionSnapshot) => void): () => void {
		this.connectListeners.add(listener);
		return () => this.connectListeners.delete(listener);
	}

	onDisconnect(listener: (payload: DisconnectPayload) => void): () => void {
		this.disconnectListeners.add(listener);
		return () => this.disconnectListeners.delete(listener);
	}

	/**
	 * Drop connections that have gone silent past `heartbeatTimeoutMs`. Call on an interval from
	 * the socket layer; a TCP connection can stay open long after the peer is gone.
	 */
	sweepIdle(): number {
		const cutoff = this.opts.now() - this.opts.heartbeatTimeoutMs;
		let closed = 0;
		for (const conn of [...this.connections]) {
			if (conn.lastSeenAt <= cutoff) {
				closed++;
				this.kill(
					conn,
					protocolError("internal", `Runner missed heartbeats for ${this.opts.heartbeatTimeoutMs}ms.`),
				);
			}
		}
		return closed;
	}

	closeAll(reason = "Gateway shutting down."): void {
		for (const conn of [...this.connections]) {
			this.kill(conn, protocolError("internal", reason));
		}
	}

	// ── internals ─────────────────────────────────────────────────────────────

	private write(conn: Connection, envelope: Envelope): void {
		try {
			conn.socket.send(JSON.stringify(envelope));
		} catch (err) {
			this.kill(
				conn,
				protocolError("internal", `Send failed: ${err instanceof Error ? err.message : String(err)}`),
			);
		}
	}

	private receive(conn: Connection, frame: string): void {
		if (conn.dead) return;
		conn.lastSeenAt = this.opts.now();

		const parsed = parseEnvelopeFrame(frame);
		if (!parsed.ok) {
			this.opts.logger("warn", "Rejected malformed runner frame", {
				runnerId: conn.runnerId,
				reason: parsed.error.message,
			});
			this.kill(conn, parsed.error);
			return;
		}

		const envelope = parsed.envelope;

		switch (envelope.kind) {
			case "event":
				this.dispatchEvent(conn, envelope.event);
				return;
			case "reply":
				if (envelope.id === conn.handshakeId) {
					this.completeHandshake(conn, envelope.result);
					return;
				}
				this.settle(conn, envelope.id, { ok: true, result: envelope.result });
				return;
			case "failure":
				if (envelope.id === conn.handshakeId) {
					this.kill(conn, envelope.error);
					return;
				}
				this.settle(conn, envelope.id, { ok: false, error: envelope.error });
				return;
			case "command":
				this.kill(
					conn,
					protocolError(
						"internal",
						"Runner sent a command envelope; the runner is not permitted to drive the control plane.",
					),
				);
				return;
		}
	}

	private completeHandshake(conn: Connection, result: CommandResult): void {
		if (result.type !== "handshake") {
			this.kill(conn, protocolError("internal", "Handshake reply carried the wrong result type."));
			return;
		}

		const info = result.runner;
		const major = protocolMajor(info.protocolVersion);
		if (major !== PROTOCOL_MAJOR) {
			this.kill(
				conn,
				protocolError(
					"protocol_version_mismatch",
					`Runner speaks protocol ${info.protocolVersion}; this control plane requires major ${PROTOCOL_MAJOR}.`,
					"Update cap-runner (or Hades) so both sides share a protocol major.",
				),
			);
			return;
		}

		if (conn.handshakeTimer) {
			clearTimeout(conn.handshakeTimer);
			conn.handshakeTimer = null;
		}

		// A reconnecting runner replaces its previous connection: the old socket is stale by
		// definition, and leaving it addressable would race two sockets for the same runner id.
		const existing = this.byRunner.get(info.runnerId);
		if (existing && existing !== conn) {
			this.kill(existing, protocolError("internal", "Replaced by a newer connection from the same runner."));
		}

		conn.runnerId = info.runnerId;
		conn.info = info;
		this.byRunner.set(info.runnerId, conn);
		conn.settleHandshake(info.runnerId);

		const snap = snapshot(conn);
		for (const listener of this.connectListeners) listener(snap);
	}

	private dispatchEvent(conn: Connection, event: RunnerEvent): void {
		if (!conn.runnerId) return;
		const payload: RunnerEventPayload = { runnerId: conn.runnerId, event };
		for (const listener of this.eventListeners) {
			try {
				listener(payload);
			} catch (err) {
				this.opts.logger("error", "Runner event listener threw", {
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
	}

	private settle(
		conn: Connection,
		id: string,
		outcome: { ok: true; result: CommandResult } | { ok: false; error: ProtocolError },
	): void {
		const pending = conn.pending.get(id);
		if (!pending) {
			this.opts.logger("warn", "Reply for unknown command id", { runnerId: conn.runnerId, id });
			return;
		}
		conn.pending.delete(id);
		clearTimeout(pending.timer);
		if (outcome.ok) pending.resolve(outcome.result);
		else pending.reject(new RunnerTransportError(outcome.error));
	}

	/** Tear a connection down and fail everything in flight on it. Idempotent. */
	private kill(conn: Connection, error: ProtocolError): void {
		if (conn.dead) return;
		conn.dead = true;

		if (conn.handshakeTimer) {
			clearTimeout(conn.handshakeTimer);
			conn.handshakeTimer = null;
		}

		this.connections.delete(conn);
		if (conn.runnerId && this.byRunner.get(conn.runnerId) === conn) {
			this.byRunner.delete(conn.runnerId);
		}

		for (const [, pending] of conn.pending) {
			clearTimeout(pending.timer);
			if (pending.onAbort) pending.signal?.removeEventListener("abort", pending.onAbort);
			pending.reject(new RunnerTransportError(error));
		}
		conn.pending.clear();

		conn.failHandshake(new RunnerTransportError(error));

		try {
			conn.socket.close(1000, error.message.slice(0, 120));
		} catch {
			// The socket layer may already have torn the socket down.
		}

		if (conn.runnerId) {
			const payload: DisconnectPayload = { runnerId: conn.runnerId, reason: error.message };
			for (const listener of this.disconnectListeners) listener(payload);
		}
	}
}

function snapshot(conn: Connection): ConnectionSnapshot {
	return {
		runnerId: conn.runnerId as string,
		info: conn.info as RunnerInfo,
		connectedAt: conn.connectedAt,
		lastSeenAt: conn.lastSeenAt,
		inFlight: conn.pending.size,
	};
}
