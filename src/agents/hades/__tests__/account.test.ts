import { describe, expect, it } from "vitest";
import { AuthError, HadesAccountService } from "../account/service";
import { InMemoryAccountStore, hashPassword, supersedes, verifyPassword } from "../account/store";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef";
const PASSWORD = "CorrectHorse9!x";

function service() {
  return new HadesAccountService({ store: new InMemoryAccountStore(), secret: SECRET });
}

describe("password hashing", () => {
  it("round-trips a password", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("something else", hash)).toBe(false);
  });

  it("never stores the password itself", async () => {
    expect(await hashPassword(PASSWORD)).not.toContain(PASSWORD);
  });

  it("salts, so the same password hashes differently each time", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("rejects a malformed digest rather than throwing", async () => {
    expect(await verifyPassword(PASSWORD, "nonsense")).toBe(false);
    expect(await verifyPassword(PASSWORD, "scrypt$zz$zz")).toBe(false);
  });
});

describe("HadesAccountService construction", () => {
  it("refuses a missing or short signing secret", () => {
    expect(() => new HadesAccountService({ secret: "" })).toThrow(/HADES_AUTH_SECRET/);
    expect(() => new HadesAccountService({ secret: "too-short" })).toThrow(/32 characters/);
  });
});

describe("sign-up", () => {
  it("creates an account and returns a session", async () => {
    const session = await service().signUp({ email: "a@b.co", password: PASSWORD });
    expect(session.user.email).toBe("a@b.co");
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).not.toBe(session.accessToken);
    expect(session.expiresAt).toBeGreaterThan(Date.now());
  });

  it("normalises the email so case does not create a second account", async () => {
    const instance = service();
    await instance.signUp({ email: "A@B.co", password: PASSWORD });
    await expect(instance.signUp({ email: "a@b.co", password: PASSWORD })).rejects.toMatchObject({
      code: "email-taken",
    });
  });

  it("rejects a weak password before creating anything", async () => {
    const instance = service();
    await expect(instance.signUp({ email: "a@b.co", password: "short" })).rejects.toMatchObject({
      code: "weak-password",
    });
    await expect(instance.signIn({ email: "a@b.co", password: "short" })).rejects.toMatchObject({
      code: "invalid-credentials",
    });
  });

  it("rejects a malformed email", async () => {
    await expect(
      service().signUp({ email: "not-an-email", password: PASSWORD }),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it("never returns the password hash to the caller", async () => {
    const session = await service().signUp({ email: "a@b.co", password: PASSWORD });
    expect(JSON.stringify(session)).not.toContain("scrypt$");
  });
});

describe("sign-in", () => {
  it("accepts the right password", async () => {
    const instance = service();
    await instance.signUp({ email: "a@b.co", password: PASSWORD });
    const session = await instance.signIn({ email: "a@b.co", password: PASSWORD });
    expect(session.user.email).toBe("a@b.co");
  });

  it("gives the same answer for a wrong password and an unknown account", async () => {
    const instance = service();
    await instance.signUp({ email: "a@b.co", password: PASSWORD });

    const wrongPassword = await instance
      .signIn({ email: "a@b.co", password: "WrongPassword9!" })
      .catch((error: AuthError) => error);
    const unknownAccount = await instance
      .signIn({ email: "nobody@b.co", password: PASSWORD })
      .catch((error: AuthError) => error);

    // Identical code, status and message: the endpoint must not answer
    // "does this email have an account".
    expect((wrongPassword as AuthError).code).toBe((unknownAccount as AuthError).code);
    expect((wrongPassword as AuthError).status).toBe((unknownAccount as AuthError).status);
    expect((wrongPassword as AuthError).message).toBe((unknownAccount as AuthError).message);
  });

  it("keeps the device id across a sign-in", async () => {
    const instance = service();
    await instance.signUp({ email: "a@b.co", password: PASSWORD });
    const session = await instance.signIn({ email: "a@b.co", password: PASSWORD, deviceId: "dev-1" });
    expect(session.deviceId).toBe("dev-1");
  });
});

describe("tokens", () => {
  it("authenticates a bearer access token", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    const account = await instance.authenticate(`Bearer ${session.accessToken}`);
    expect(account.email).toBe("a@b.co");
  });

  it("refuses a refresh token used as an access token", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    await expect(instance.authenticate(`Bearer ${session.refreshToken}`)).rejects.toMatchObject({
      code: "invalid-credentials",
    });
  });

  it("refuses an access token used to refresh", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    await expect(instance.refresh(session.accessToken)).rejects.toBeInstanceOf(AuthError);
  });

  it("refuses a token signed with a different secret", async () => {
    const mine = service();
    const session = await mine.signUp({ email: "a@b.co", password: PASSWORD });
    const theirs = new HadesAccountService({
      store: new InMemoryAccountStore(),
      secret: "ffffffffffffffffffffffffffffffffffffffffffffffff",
    });
    await expect(theirs.authenticate(`Bearer ${session.accessToken}`)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it("refuses a missing or garbage bearer token", async () => {
    const instance = service();
    await expect(instance.authenticate(null)).rejects.toBeInstanceOf(AuthError);
    await expect(instance.authenticate("Bearer not.a.jwt")).rejects.toBeInstanceOf(AuthError);
  });

  it("mints a fresh session from a refresh token", async () => {
    const instance = service();
    const first = await instance.signUp({ email: "a@b.co", password: PASSWORD, deviceId: "d1" });
    const second = await instance.refresh(first.refreshToken);
    expect(second.user.id).toBe(first.user.id);
    expect(second.deviceId).toBe("d1");
    await expect(instance.authenticate(`Bearer ${second.accessToken}`)).resolves.toBeTruthy();
  });
});

describe("sync", () => {
  const record = (overrides: Partial<{ revision: number; updatedAt: number; deviceId: string }> = {}) => ({
    type: "workspace",
    id: "w1",
    revision: 1,
    updatedAt: 100,
    deviceId: "d1",
    data: { name: "Home" },
    ...overrides,
  });

  it("returns what it was given, with a cursor to page from", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    const result = await instance.sync(session.user.id, {
      deviceId: "d1",
      since: 0,
      records: [record()],
    });
    expect(result.cursor).toBe(1);
    expect(result.records).toHaveLength(1);
  });

  it("only returns records newer than the client's cursor", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    const first = await instance.sync(session.user.id, { deviceId: "d1", since: 0, records: [record()] });
    const second = await instance.sync(session.user.id, {
      deviceId: "d1",
      since: first.cursor,
      records: [],
    });
    expect(second.records).toEqual([]);
  });

  it("lets a newer revision win and ignores a stale push", async () => {
    const instance = service();
    const session = await instance.signUp({ email: "a@b.co", password: PASSWORD });
    await instance.sync(session.user.id, { deviceId: "d1", since: 0, records: [record({ revision: 5 })] });
    await instance.sync(session.user.id, { deviceId: "d2", since: 0, records: [record({ revision: 2 })] });

    const state = await instance.sync(session.user.id, { deviceId: "d1", since: 0, records: [] });
    const workspace = state.records.find((entry) => entry.id === "w1");
    expect(workspace?.revision).toBe(5);
  });

  it("keeps one user's records out of another's", async () => {
    const instance = service();
    const alice = await instance.signUp({ email: "alice@b.co", password: PASSWORD });
    const bob = await instance.signUp({ email: "bob@b.co", password: PASSWORD });
    await instance.sync(alice.user.id, { deviceId: "d1", since: 0, records: [record()] });

    const bobsView = await instance.sync(bob.user.id, { deviceId: "d2", since: 0, records: [] });
    expect(bobsView.records).toEqual([]);
  });
});

describe("supersedes", () => {
  const base = { revision: 1, updatedAt: 100, deviceId: "a" };

  it("prefers the higher revision, then the newer timestamp, then the larger device id", () => {
    expect(supersedes({ ...base, revision: 2 }, base)).toBe(true);
    expect(supersedes({ ...base, revision: 0 }, base)).toBe(false);
    expect(supersedes({ ...base, updatedAt: 200 }, base)).toBe(true);
    expect(supersedes({ ...base, deviceId: "z" }, base)).toBe(true);
    expect(supersedes(base, base)).toBe(false);
  });

  it("agrees with itself in both directions, so peers converge", () => {
    const left = { revision: 1, updatedAt: 100, deviceId: "a" };
    const right = { revision: 1, updatedAt: 100, deviceId: "b" };
    expect(supersedes(right, left)).toBe(true);
    expect(supersedes(left, right)).toBe(false);
  });
});

describe("malformed digests are never accepted", () => {
  it("rejects a digest whose hash is not valid hex", async () => {
    // Buffer.from("zz", "hex") is empty; without a format check the comparison
    // would be between two empty buffers and every password would pass.
    expect(await verifyPassword("anything", "scrypt$aabb$zz")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$zz$aabb")).toBe(false);
  });

  it("rejects a digest of the wrong length", async () => {
    expect(await verifyPassword("anything", `scrypt$${"00".repeat(16)}$00`)).toBe(false);
    expect(await verifyPassword("anything", `scrypt$${"00".repeat(16)}$`)).toBe(false);
  });

  it("rejects an unknown scheme rather than guessing", async () => {
    expect(await verifyPassword("anything", `bcrypt$${"00".repeat(16)}$${"00".repeat(64)}`)).toBe(
      false,
    );
  });

  it("rejects an odd-length hex string", async () => {
    expect(await verifyPassword("anything", `scrypt$abc$${"00".repeat(64)}`)).toBe(false);
  });
});
