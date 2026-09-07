import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import {
  InMemoryAccountStore,
  hashPassword,
  newAccountId,
  normaliseEmail,
  supersedes,
  verifyPassword,
  type AccountRecord,
  type AccountStore,
  type SyncRecordInput,
  type SyncRecordRow,
} from "./store";

/**
 * The account service behind the browser's sign-in and sync. Sessions are
 * HS256 JWTs signed with `HADES_AUTH_SECRET`; access tokens are short-lived and
 * refresh tokens carry a distinct type claim, so a stolen access token cannot
 * be replayed to mint new ones.
 */

export interface HadesUser {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
  walletInitialised: boolean;
}

export interface AuthSession {
  user: HadesUser;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
}

export type AuthErrorCode =
  | "invalid-credentials"
  | "email-taken"
  | "weak-password"
  | "rate-limited"
  | "unknown";

export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const ACCESS_TTL_SECONDS = 60 * 60;
const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface HadesAccountServiceOptions {
  store?: AccountStore;
  secret?: string;
  issuer?: string;
}

export class HadesAccountService {
  readonly store: AccountStore;
  readonly #secret: Uint8Array;
  readonly #issuer: string;

  constructor(options: HadesAccountServiceOptions = {}) {
    this.store = options.store ?? new InMemoryAccountStore();
    const secret = options.secret ?? process.env.HADES_AUTH_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        "HADES_AUTH_SECRET must be set to at least 32 characters. Generate one with `openssl rand -hex 32`.",
      );
    }
    this.#secret = new TextEncoder().encode(secret);
    this.#issuer = options.issuer ?? "hades";
  }

  async signUp(input: {
    email: string;
    password: string;
    displayName?: string;
    deviceId?: string;
  }): Promise<AuthSession> {
    const email = normaliseEmail(input.email);
    if (!isValidEmail(email)) {
      throw new AuthError("invalid-credentials", "That does not look like an email address.");
    }
    const strength = checkPassword(input.password);
    if (!strength.ok) throw new AuthError("weak-password", strength.reason!);

    if (await this.store.findByEmail(email)) {
      throw new AuthError("email-taken", "An account already exists for that address.", 409);
    }

    const account: AccountRecord = {
      id: newAccountId(),
      email,
      displayName: input.displayName,
      passwordHash: await hashPassword(input.password),
      createdAt: Date.now(),
      walletInitialised: false,
    };
    await this.store.create(account);
    return this.#session(account, input.deviceId);
  }

  async signIn(input: {
    email: string;
    password: string;
    deviceId?: string;
  }): Promise<AuthSession> {
    const account = await this.store.findByEmail(input.email);
    // Hash regardless so a missing account and a wrong password take the same
    // time — otherwise the endpoint answers "does this email exist".
    const hash = account?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(input.password, hash);
    if (!account || !ok) {
      throw new AuthError("invalid-credentials", "That email and password do not match.", 401);
    }
    return this.#session(account, input.deviceId);
  }

  async refresh(refreshToken: string, deviceId?: string): Promise<AuthSession> {
    const claims = await this.#verify(refreshToken, "refresh");
    const account = await this.store.findById(claims.sub);
    if (!account) {
      throw new AuthError("invalid-credentials", "That session no longer exists.", 401);
    }
    return this.#session(account, deviceId ?? claims.did);
  }

  /** Resolve a bearer access token to a user, for the sync endpoint. */
  async authenticate(authorization: string | null): Promise<AccountRecord> {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new AuthError("invalid-credentials", "Missing bearer token.", 401);
    const claims = await this.#verify(token, "access");
    const account = await this.store.findById(claims.sub);
    if (!account) throw new AuthError("invalid-credentials", "Unknown account.", 401);
    return account;
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  async sync(
    userId: string,
    input: { deviceId: string; since: number; records: SyncRecordInput[] },
  ): Promise<{ cursor: number; records: SyncRecordRow[] }> {
    // Write first, then read back from the same cursor the client sent. The
    // client filters its own echo, and doing it in this order means a record
    // written by another device between the two steps is never skipped.
    //
    // Payloads are sealed and stay sealed: this method orders records by
    // their metadata and never looks inside `enc`, because it cannot.
    if (input.records.length > 0) {
      await this.store.putRecords(userId, input.records.map((record) => ({ ...record, userId })));
    }
    const records = await this.store.recordsSince(userId, input.since);
    const cursor = await this.store.cursor(userId);
    return { cursor, records };
  }

  async #session(account: AccountRecord, deviceId?: string): Promise<AuthSession> {
    const device = deviceId ?? randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const [accessToken, refreshToken] = await Promise.all([
      this.#sign(account.id, "access", device, now + ACCESS_TTL_SECONDS),
      this.#sign(account.id, "refresh", device, now + REFRESH_TTL_SECONDS),
    ]);
    return {
      user: toUser(account),
      accessToken,
      refreshToken,
      expiresAt: (now + ACCESS_TTL_SECONDS) * 1000,
      deviceId: device,
    };
  }

  #sign(subject: string, type: "access" | "refresh", deviceId: string, exp: number): Promise<string> {
    return new SignJWT({ typ: type, did: deviceId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(subject)
      .setIssuer(this.#issuer)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.#secret);
  }

  async #verify(token: string, expected: "access" | "refresh"): Promise<{ sub: string; did?: string }> {
    try {
      const { payload } = await jwtVerify(token, this.#secret, { issuer: this.#issuer });
      // Without this check a refresh token would work as an access token and
      // vice versa, which defeats having two lifetimes at all.
      if (payload.typ !== expected) {
        throw new AuthError("invalid-credentials", `Expected a ${expected} token.`, 401);
      }
      if (typeof payload.sub !== "string") {
        throw new AuthError("invalid-credentials", "Malformed token.", 401);
      }
      return { sub: payload.sub, did: typeof payload.did === "string" ? payload.did : undefined };
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError("invalid-credentials", "That session is not valid.", 401);
    }
  }
}

function toUser(account: AccountRecord): HadesUser {
  return {
    id: account.id,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt,
    walletInitialised: account.walletInitialised,
  };
}

export function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

export function checkPassword(password: string): { ok: boolean; reason?: string } {
  if (password.length < 12) return { ok: false, reason: "Use at least 12 characters." };
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return { ok: false, reason: "Mix upper and lower case." };
  }
  if (!/\d/.test(password) && !/[^\w\s]/.test(password)) {
    return { ok: false, reason: "Add a number or a symbol." };
  }
  return { ok: true };
}

export { supersedes };

/**
 * A well-formed digest of a value nobody holds, so signing in with an unknown
 * email runs the same scrypt work as signing in with a wrong password. It has
 * to pass verifyPassword's format checks, or the comparison would short-circuit
 * and reintroduce the timing difference this exists to remove.
 */
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;
