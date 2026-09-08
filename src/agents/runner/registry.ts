/**
 * Runner registry — device-code pairing, runner records and durable session state.
 *
 * Follows the StateStore adapter pattern used by `workflow/state.ts` and
 * `security/redis-jti-store.ts`: one narrow interface with an in-memory default that a
 * deployment swaps for Postgres/Redis. It deliberately does NOT extend `DbAdapter`, which
 * would force the same migration through all four DB adapters.
 *
 * The in-memory default is SINGLE-INSTANCE ONLY: pairing codes and session records live in
 * one process's heap, so a second Next.js instance (or a serverless cold start) will not see
 * a code issued by the first. Install a shared store before running more than one instance.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Scope, SessionEndReason, SessionGuard, SessionState } from "./protocol";

export type PairingStatus = "pending" | "approved" | "denied" | "claimed" | "expired";

export interface RunnerIdentity {
	runnerId: string;
	/** Ed25519 public key (base64) the runner signs its pairing request with. */
	publicKey: string;
	os: string;
	osVersion: string;
	arch: string;
	capVersion: string;
	protocolVersion: string;
}

export interface RunnerRecord extends RunnerIdentity {
	/** Owner of the paired machine. Every session for this runner is authorized against it. */
	userId: string;
	grantedScopes: Scope[];
	pairedAt: number;
	lastSeenAt: number;
	revokedAt?: number;
}

export interface PairingRequest {
	/** Short, human-transcribable code the runner displays. */
	userCode: string;
	/** High-entropy secret the runner polls with. Never shown to the user. */
	deviceCode: string;
	identity: RunnerIdentity;
	requestedScopes: Scope[];
	status: PairingStatus;
	createdAt: number;
	expiresAt: number;
	/** Populated once a user approves. */
	userId?: string;
	grantedScopes?: Scope[];
	/** Minimum seconds the runner should wait between polls. */
	pollIntervalSec: number;
}

export interface RunnerSessionRecord {
	sessionId: string;
	runnerId: string;
	runId: string;
	userId: string;
	state: SessionState;
	grantedScopes: Scope[];
	guard: SessionGuard;
	startedAt: number;
	expiresAt: number;
	endedAt?: number;
	endReason?: SessionEndReason;
	/** jti of the capability token minted for this session, so it can be revoked on end. */
	capabilityJti?: string;
}

// ── Store adapter ─────────────────────────────────────────────────────────────

export interface RunnerStore {
	saveRunner(record: RunnerRecord): Promise<void>;
	getRunner(runnerId: string): Promise<RunnerRecord | null>;
	listRunners(userId?: string): Promise<RunnerRecord[]>;
	deleteRunner(runnerId: string): Promise<void>;

	savePairing(request: PairingRequest): Promise<void>;
	getPairingByUserCode(userCode: string): Promise<PairingRequest | null>;
	getPairingByDeviceCode(deviceCode: string): Promise<PairingRequest | null>;
	deletePairing(deviceCode: string): Promise<void>;

	saveSession(record: RunnerSessionRecord): Promise<void>;
	getSession(sessionId: string): Promise<RunnerSessionRecord | null>;
	listSessions(filter?: { runnerId?: string; runId?: string; userId?: string }): Promise<RunnerSessionRecord[]>;
}

function cloneRunner(record: RunnerRecord): RunnerRecord {
	return { ...record, grantedScopes: [...record.grantedScopes] };
}

function clonePairing(request: PairingRequest): PairingRequest {
	return {
		...request,
		identity: { ...request.identity },
		requestedScopes: [...request.requestedScopes],
		...(request.grantedScopes ? { grantedScopes: [...request.grantedScopes] } : {}),
	};
}

function cloneSession(record: RunnerSessionRecord): RunnerSessionRecord {
	return {
		...record,
		grantedScopes: [...record.grantedScopes],
		guard: {
			...record.guard,
			allowedBundleIds: [...record.guard.allowedBundleIds],
			redactedTitlePatterns: [...record.guard.redactedTitlePatterns],
		},
	};
}

/** Every read and write copies: a caller must not be able to mutate stored state in place. */
export class InMemoryRunnerStore implements RunnerStore {
	private readonly runners = new Map<string, RunnerRecord>();
	private readonly pairingsByDeviceCode = new Map<string, PairingRequest>();
	private readonly pairingsByUserCode = new Map<string, string>();
	private readonly sessions = new Map<string, RunnerSessionRecord>();

	async saveRunner(record: RunnerRecord): Promise<void> {
		this.runners.set(record.runnerId, cloneRunner(record));
	}

	async getRunner(runnerId: string): Promise<RunnerRecord | null> {
		const found = this.runners.get(runnerId);
		return found ? cloneRunner(found) : null;
	}

	async listRunners(userId?: string): Promise<RunnerRecord[]> {
		const all = [...this.runners.values()].map(cloneRunner);
		return userId ? all.filter((r) => r.userId === userId) : all;
	}

	async deleteRunner(runnerId: string): Promise<void> {
		this.runners.delete(runnerId);
	}

	async savePairing(request: PairingRequest): Promise<void> {
		this.pairingsByDeviceCode.set(request.deviceCode, clonePairing(request));
		this.pairingsByUserCode.set(request.userCode, request.deviceCode);
	}

	async getPairingByUserCode(userCode: string): Promise<PairingRequest | null> {
		const deviceCode = this.pairingsByUserCode.get(userCode);
		if (!deviceCode) return null;
		return this.getPairingByDeviceCode(deviceCode);
	}

	async getPairingByDeviceCode(deviceCode: string): Promise<PairingRequest | null> {
		const found = this.pairingsByDeviceCode.get(deviceCode);
		return found ? clonePairing(found) : null;
	}

	async deletePairing(deviceCode: string): Promise<void> {
		const found = this.pairingsByDeviceCode.get(deviceCode);
		if (found) this.pairingsByUserCode.delete(found.userCode);
		this.pairingsByDeviceCode.delete(deviceCode);
	}

	async saveSession(record: RunnerSessionRecord): Promise<void> {
		this.sessions.set(record.sessionId, cloneSession(record));
	}

	async getSession(sessionId: string): Promise<RunnerSessionRecord | null> {
		const found = this.sessions.get(sessionId);
		return found ? cloneSession(found) : null;
	}

	async listSessions(filter?: {
		runnerId?: string;
		runId?: string;
		userId?: string;
	}): Promise<RunnerSessionRecord[]> {
		let all = [...this.sessions.values()].map(cloneSession);
		if (filter?.runnerId) all = all.filter((s) => s.runnerId === filter.runnerId);
		if (filter?.runId) all = all.filter((s) => s.runId === filter.runId);
		if (filter?.userId) all = all.filter((s) => s.userId === filter.userId);
		return all;
	}
}

let _runnerStore: RunnerStore | undefined;

/** Replace the process-wide runner store. Call once at startup, before any pairing begins. */
export function setRunnerStore(store: RunnerStore): void {
	_runnerStore = store;
}

export function getRunnerStore(): RunnerStore {
	if (!_runnerStore) _runnerStore = new InMemoryRunnerStore();
	return _runnerStore;
}

// ── Device-code pairing ───────────────────────────────────────────────────────

/** Excludes 0/O/1/I/L so a code read off a screen cannot be mistranscribed. */
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const USER_CODE_LENGTH = 8;

export const PAIRING_TTL_MS = 10 * 60_000;
export const PAIRING_POLL_INTERVAL_SEC = 5;

function randomUserCode(): string {
	const bytes = new Uint8Array(USER_CODE_LENGTH);
	globalThis.crypto.getRandomValues(bytes);
	let out = "";
	for (let i = 0; i < USER_CODE_LENGTH; i++) {
		out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
		if (i === 3) out += "-";
	}
	return out;
}

/** Normalises what a user typed: case, spaces and dashes are not part of the secret. */
export function normalizeUserCode(input: string): string {
	const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
	return cleaned.length === USER_CODE_LENGTH
		? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`
		: cleaned;
}

export class PairingError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(message);
		this.name = "PairingError";
		this.code = code;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

export interface StartPairingResult {
	userCode: string;
	deviceCode: string;
	expiresAt: number;
	pollIntervalSec: number;
}

/** Step 1 — the runner asks to be paired and displays the returned `userCode`. */
export async function startPairing(
	identity: RunnerIdentity,
	requestedScopes: Scope[],
	store: RunnerStore = getRunnerStore(),
	now: number = Date.now(),
): Promise<StartPairingResult> {
	const request: PairingRequest = {
		userCode: randomUserCode(),
		deviceCode: randomUUID() + randomUUID().replace(/-/g, ""),
		identity,
		requestedScopes: [...new Set(requestedScopes)].sort(),
		status: "pending",
		createdAt: now,
		expiresAt: now + PAIRING_TTL_MS,
		pollIntervalSec: PAIRING_POLL_INTERVAL_SEC,
	};
	await store.savePairing(request);
	return {
		userCode: request.userCode,
		deviceCode: request.deviceCode,
		expiresAt: request.expiresAt,
		pollIntervalSec: request.pollIntervalSec,
	};
}

/**
 * Step 2 — an authenticated user approves the code shown on the machine.
 * `grantedScopes` may only narrow what the runner asked for; a user cannot be tricked into
 * granting an authority the runner did not request, and Hades cannot widen one silently.
 */
export async function approvePairing(
	userCode: string,
	userId: string,
	grantedScopes: Scope[],
	store: RunnerStore = getRunnerStore(),
	now: number = Date.now(),
): Promise<RunnerRecord> {
	const request = await store.getPairingByUserCode(normalizeUserCode(userCode));
	if (!request) throw new PairingError("No pairing request for that code.", "PAIRING_NOT_FOUND");
	if (request.status !== "pending") {
		throw new PairingError(`Pairing request is already "${request.status}".`, "PAIRING_NOT_PENDING");
	}
	if (now > request.expiresAt) {
		await store.savePairing({ ...request, status: "expired" });
		throw new PairingError("Pairing code expired.", "PAIRING_EXPIRED");
	}

	const requested = new Set(request.requestedScopes);
	const widened = grantedScopes.filter((s) => !requested.has(s));
	if (widened.length > 0) {
		throw new PairingError(
			`Cannot grant scopes the runner did not request: ${widened.join(", ")}.`,
			"PAIRING_SCOPE_WIDENED",
		);
	}

	const granted = [...new Set(grantedScopes)].sort();
	await store.savePairing({ ...request, status: "approved", userId, grantedScopes: granted });

	const record: RunnerRecord = {
		...request.identity,
		userId,
		grantedScopes: granted,
		pairedAt: now,
		lastSeenAt: now,
	};
	await store.saveRunner(record);
	return record;
}

export async function denyPairing(
	userCode: string,
	store: RunnerStore = getRunnerStore(),
): Promise<void> {
	const request = await store.getPairingByUserCode(normalizeUserCode(userCode));
	if (!request) throw new PairingError("No pairing request for that code.", "PAIRING_NOT_FOUND");
	await store.savePairing({ ...request, status: "denied" });
}

export type ClaimPairingResult =
	| { status: "pending"; pollIntervalSec: number }
	| { status: "denied" }
	| { status: "expired" }
	| { status: "approved"; runner: RunnerRecord };

/**
 * Step 3 — the runner polls with its device code. Approved requests are marked `claimed` so a
 * leaked device code cannot be redeemed twice.
 */
export async function claimPairing(
	deviceCode: string,
	store: RunnerStore = getRunnerStore(),
	now: number = Date.now(),
): Promise<ClaimPairingResult> {
	const request = await store.getPairingByDeviceCode(deviceCode);
	if (!request) throw new PairingError("Unknown device code.", "PAIRING_NOT_FOUND");

	if (request.status === "denied") return { status: "denied" };
	if (request.status === "claimed") throw new PairingError("Device code already used.", "PAIRING_ALREADY_CLAIMED");
	if (request.status === "expired" || now > request.expiresAt) {
		await store.savePairing({ ...request, status: "expired" });
		return { status: "expired" };
	}
	if (request.status === "pending") {
		return { status: "pending", pollIntervalSec: request.pollIntervalSec };
	}

	const runner = await store.getRunner(request.identity.runnerId);
	if (!runner) throw new PairingError("Approved runner record is missing.", "PAIRING_RUNNER_MISSING");

	await store.savePairing({ ...request, status: "claimed" });
	return { status: "approved", runner };
}

/** Constant-time device-code comparison for callers that look a code up by other means. */
export function deviceCodeMatches(a: string, b: string): boolean {
	const left = Buffer.from(a, "utf8");
	const right = Buffer.from(b, "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

export async function revokeRunner(
	runnerId: string,
	store: RunnerStore = getRunnerStore(),
	now: number = Date.now(),
): Promise<void> {
	const runner = await store.getRunner(runnerId);
	if (!runner) return;
	await store.saveRunner({ ...runner, revokedAt: now, grantedScopes: [] });
}

export async function touchRunner(
	runnerId: string,
	store: RunnerStore = getRunnerStore(),
	now: number = Date.now(),
): Promise<void> {
	const runner = await store.getRunner(runnerId);
	if (!runner) return;
	await store.saveRunner({ ...runner, lastSeenAt: now });
}
