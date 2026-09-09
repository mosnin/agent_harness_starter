/**
 * RunnerGateway — authorization and durable state on top of the transport multiplexer.
 *
 * The multiplexer knows only about frames. The gateway is what decides whether a command may
 * be sent at all: it narrows requested scopes against what the user granted at pairing, mints
 * the per-run capability token the runner independently re-verifies, records session state,
 * and turns unsolicited runner events into resumable per-run streams.
 *
 * Session capability tokens are held in memory only, never written to the store — a durable
 * copy of a bearer token is a liability, and a token can always be re-minted from the record.
 */

import { AgentError } from "../errors";
import { mintRunnerCapabilityToken } from "../security/capability-plugin";
import { RunnerTransportError, type SessionMultiplexer } from "../transport/multiplexer";
import {
	type Command,
	type CommandResult,
	type ErrorCode,
	type RunnerEvent,
	type Scope,
	type SessionEndReason,
	type SessionGuard,
	type SessionLease,
	denyAllGuard,
	protocolError,
	requiredScopesForCommand,
	scopeSet,
} from "./protocol";
import {
	type RunnerSessionRecord,
	type RunnerStore,
	getRunnerStore,
	touchRunner,
} from "./registry";
import { RunStream, runnerEventToAgentEvent } from "./stream";

export class RunnerGatewayError extends AgentError {
	constructor(message: string, code = "RUNNER_GATEWAY_ERROR", remediation?: string) {
		super(message, code, remediation);
		this.name = "RunnerGatewayError";
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface RunnerGatewayOptions {
	mux: SessionMultiplexer;
	store?: RunnerStore;
	/** Capability-token lifetime. Must outlive the session lease. Default "30m". */
	tokenTtl?: string;
	/** Session lease duration when the caller supplies no guard ceiling. Default 15 minutes. */
	defaultSessionMs?: number;
	/** Audience embedded in minted tokens and enforced on verification. Default "cap-runner". */
	audience?: string;
	now?: () => number;
}

export interface StartSessionOptions {
	runnerId: string;
	runId: string;
	userId: string;
	requestedScopes: Scope[];
	guard?: SessionGuard;
	ttl?: string;
	timeoutMs?: number;
}

export interface StartedSession {
	lease: SessionLease;
	record: RunnerSessionRecord;
	/** Hand to the agent run as `context.capabilityToken`; never persist it. */
	capabilityToken: string;
	grantedTools: string[];
}

export class RunnerGateway {
	private readonly mux: SessionMultiplexer;
	private readonly store: RunnerStore;
	private readonly tokenTtl: string;
	private readonly defaultSessionMs: number;
	private readonly audience: string;
	private readonly now: () => number;
	private readonly tokens = new Map<string, { token: string; scopes: Scope[] }>();
	private readonly owners = new Map<string, { runnerId: string; runId: string }>();
	private readonly streams = new Map<string, RunStream>();
	private readonly unsubscribe: () => void;

	constructor(options: RunnerGatewayOptions) {
		this.mux = options.mux;
		this.store = options.store ?? getRunnerStore();
		this.tokenTtl = options.tokenTtl ?? "30m";
		this.defaultSessionMs = options.defaultSessionMs ?? 15 * 60_000;
		this.audience = options.audience ?? "cap-runner";
		this.now = options.now ?? (() => Date.now());

		this.unsubscribe = this.mux.onEvent(({ runnerId, event }) => {
			void this.handleRunnerEvent(runnerId, event);
		});
	}

	dispose(): void {
		this.unsubscribe();
		for (const stream of this.streams.values()) stream.close();
		this.streams.clear();
		this.tokens.clear();
		this.owners.clear();
	}

	/**
	 * Open a session on a paired runner.
	 *
	 * Requested scopes are intersected with what the user granted at pairing; a request for an
	 * ungranted scope fails rather than being silently dropped, so a caller cannot believe it
	 * has an authority it does not.
	 */
	async startSession(options: StartSessionOptions): Promise<StartedSession> {
		const runner = await this.store.getRunner(options.runnerId);
		if (!runner) {
			throw new RunnerGatewayError(
				`Runner "${options.runnerId}" is not paired.`,
				"RUNNER_NOT_PAIRED",
				"Pair the machine from Settings → Devices before starting a session.",
			);
		}
		if (runner.revokedAt) {
			throw new RunnerGatewayError(`Runner "${options.runnerId}" was revoked.`, "RUNNER_REVOKED");
		}
		if (runner.userId !== options.userId) {
			throw new RunnerGatewayError(
				`Runner "${options.runnerId}" belongs to another user.`,
				"RUNNER_NOT_OWNED",
			);
		}

		const granted = new Set(runner.grantedScopes);
		const missing = options.requestedScopes.filter((s) => !granted.has(s));
		if (missing.length > 0) {
			throw new RunnerGatewayError(
				`Runner "${options.runnerId}" was not granted: ${missing.join(", ")}.`,
				"RUNNER_SCOPE_DENIED",
				"Re-pair the machine and approve the additional scopes.",
			);
		}

		const scopes = [...new Set(options.requestedScopes)].sort();
		const guard = options.guard ?? denyAllGuard();

		const minted = await mintRunnerCapabilityToken({
			sub: options.userId,
			runId: options.runId,
			scopes,
			agentName: this.audience,
			aud: this.audience,
			ttl: options.ttl ?? this.tokenTtl,
		});

		const result = await this.mux.send(
			options.runnerId,
			{
				type: "sessionStart",
				runId: options.runId,
				requestedScopes: scopeSet(scopes),
				guard,
			},
			minted.token,
			options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
		);

		if (result.type !== "sessionStarted") {
			throw new RunnerGatewayError(
				`Runner answered sessionStart with "${result.type}".`,
				"RUNNER_PROTOCOL_VIOLATION",
			);
		}

		const lease = result.lease;
		const existing = await this.store.getSession(lease.sessionId);
		if (existing) {
			void this.mux
				.send(options.runnerId, { type: "sessionEnd", reason: "control_plane_cancelled" }, minted.token)
				.catch(() => {});
			throw new RunnerGatewayError(
				`Runner answered sessionStart with a session id that is already in use ("${lease.sessionId}").`,
				"RUNNER_PROTOCOL_VIOLATION",
			);
		}

		// The lease is the runner's word; the token is ours. A command is authorized only by what
		// both grant, so a lease that widens the request cannot widen the session.
		const tokenScopes = new Set(minted.scopes);
		const startedAt = this.now();
		const record: RunnerSessionRecord = {
			sessionId: lease.sessionId,
			runnerId: options.runnerId,
			runId: options.runId,
			userId: options.userId,
			state: "active",
			grantedScopes: lease.grantedScopes.scopes.filter((s) => tokenScopes.has(s)).sort(),
			guard: lease.guard,
			startedAt,
			expiresAt: lease.expiresAtUnixMs || startedAt + this.defaultSessionMs,
		};

		await this.store.saveSession(record);
		this.tokens.set(lease.sessionId, { token: minted.token, scopes: minted.scopes });
		this.owners.set(lease.sessionId, { runnerId: options.runnerId, runId: options.runId });
		this.streams.set(lease.sessionId, new RunStream());
		await touchRunner(options.runnerId, this.store, startedAt);

		return { lease, record, capabilityToken: minted.token, grantedTools: minted.tools };
	}

	/**
	 * Send a command inside an open session.
	 *
	 * Enforced here rather than trusted from the caller: the session must be active and unexpired,
	 * and every scope the command needs must be in the lease. The runner re-checks the same thing
	 * against the capability token, so a bug on this side cannot by itself exceed the grant.
	 */
	async dispatch(
		sessionId: string,
		command: Command,
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<CommandResult> {
		const record = await this.store.getSession(sessionId);
		if (!record) {
			throw new RunnerGatewayError(`Unknown session "${sessionId}".`, "RUNNER_SESSION_NOT_FOUND");
		}
		if (record.state !== "active") {
			throw new RunnerGatewayError(
				`Session "${sessionId}" is "${record.state}".`,
				"RUNNER_SESSION_NOT_ACTIVE",
			);
		}
		if (this.now() > record.expiresAt) {
			await this.markEnded(record, "max_duration_reached");
			throw new RunnerGatewayError(`Session "${sessionId}" expired.`, "RUNNER_SESSION_EXPIRED");
		}

		const runner = await this.store.getRunner(record.runnerId);
		if (!runner || runner.revokedAt) {
			await this.markEnded(record, "control_plane_cancelled");
			throw new RunnerGatewayError(
				`Runner "${record.runnerId}" was revoked; session "${sessionId}" is closed.`,
				"RUNNER_REVOKED",
			);
		}

		const held = this.tokens.get(sessionId);
		if (!held) {
			throw new RunnerGatewayError(
				`No capability token held for session "${sessionId}". Start a new session.`,
				"RUNNER_TOKEN_MISSING",
			);
		}

		const leaseGranted = new Set(record.grantedScopes);
		const tokenGranted = new Set(held.scopes);
		const needed = requiredScopesForCommand(command);
		const missing = needed.filter((s) => !leaseGranted.has(s) || !tokenGranted.has(s));
		if (missing.length > 0) {
			throw new RunnerGatewayError(
				`Command "${command.type}" needs ungranted scopes: ${missing.join(", ")}.`,
				"RUNNER_SCOPE_DENIED",
			);
		}

		return this.mux.send(record.runnerId, command, held.token, options);
	}

	async endSession(
		sessionId: string,
		reason: SessionEndReason = "completed",
		options: { timeoutMs?: number } = {},
	): Promise<void> {
		const record = await this.store.getSession(sessionId);
		if (!record) return;

		const held = this.tokens.get(sessionId);
		if (held && this.mux.isConnected(record.runnerId)) {
			try {
				await this.mux.send(
					record.runnerId,
					{ type: "sessionEnd", reason },
					held.token,
					options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
				);
			} catch (err) {
				if (!(err instanceof RunnerTransportError)) throw err;
			}
		}

		await this.markEnded(record, reason);
	}

	/** Resumable event stream for a session. Pass a `Last-Event-ID` cursor to replay. */
	stream(sessionId: string): RunStream {
		let stream = this.streams.get(sessionId);
		if (!stream) {
			stream = new RunStream();
			this.streams.set(sessionId, stream);
		}
		return stream;
	}

	async listSessions(filter?: {
		runnerId?: string;
		runId?: string;
		userId?: string;
	}): Promise<RunnerSessionRecord[]> {
		return this.store.listSessions(filter);
	}

	private async markEnded(record: RunnerSessionRecord, reason: SessionEndReason): Promise<void> {
		await this.store.saveSession({
			...record,
			state: "ended",
			endedAt: this.now(),
			endReason: reason,
		});
		this.tokens.delete(record.sessionId);
		this.owners.delete(record.sessionId);
		this.streams.get(record.sessionId)?.close();
	}

	private async storedOwner(
		sessionId: string,
	): Promise<{ runnerId: string; runId: string } | null> {
		const record = await this.store.getSession(sessionId);
		return record ? { runnerId: record.runnerId, runId: record.runId } : null;
	}

	private async handleRunnerEvent(runnerId: string, event: RunnerEvent): Promise<void> {
		if (event.type === "heartbeat") {
			await touchRunner(runnerId, this.store, this.now());
			return;
		}

		// A runner may only speak for sessions it owns. Sessions this process opened resolve
		// synchronously so their events land in the stream on the same tick; anything else is
		// looked up, and an unknown session is nobody's.
		const owner =
			this.owners.get(event.sessionId) ?? (await this.storedOwner(event.sessionId));
		if (!owner || owner.runnerId !== runnerId) return;

		const agentEvent = runnerEventToAgentEvent(event);
		if (agentEvent) {
			this.stream(event.sessionId).push(
				agentEvent.type === "approval_required" ? { ...agentEvent, runId: owner.runId } : agentEvent,
			);
		}

		if (event.type === "sessionEnded") {
			const record = await this.store.getSession(event.sessionId);
			if (record) await this.markEnded(record, event.reason);
			return;
		}

		if (event.type === "killSwitchEngaged") {
			const record = await this.store.getSession(event.sessionId);
			if (record) await this.markEnded(record, "user_kill_switch");
		}
	}
}

/** Transport failures surface as protocol errors so routes can render a runner-shaped error. */
export function toProtocolError(err: unknown) {
	if (err instanceof RunnerTransportError) return err.protocol;
	if (err instanceof RunnerGatewayError) {
		return protocolError(gatewayErrorCode(err.code), err.message, err.remediation);
	}
	return protocolError("internal", err instanceof Error ? err.message : String(err));
}

function gatewayErrorCode(code: string): ErrorCode {
	switch (code) {
		case "RUNNER_SESSION_EXPIRED":
			return "session_expired";
		case "RUNNER_SESSION_NOT_FOUND":
		case "RUNNER_SESSION_NOT_ACTIVE":
		case "RUNNER_TOKEN_MISSING":
			return "no_active_session";
		case "RUNNER_NOT_PAIRED":
		case "RUNNER_REVOKED":
			return "unauthenticated";
		case "RUNNER_PROTOCOL_VIOLATION":
			return "internal";
		default:
			return "scope_denied";
	}
}

// ── Process-wide gateway ──────────────────────────────────────────────────────

let _gateway: RunnerGateway | undefined;

/**
 * Install the gateway this process serves from. Single-instance only: the multiplexer holds
 * live sockets in one process's heap, so a second Next.js instance sees no connections and no
 * event streams. Split deployments must reach the socket-owning process over RPC instead.
 */
export function setRunnerGateway(gateway: RunnerGateway): void {
	_gateway = gateway;
}

export function getRunnerGateway(): RunnerGateway | undefined {
	return _gateway;
}
