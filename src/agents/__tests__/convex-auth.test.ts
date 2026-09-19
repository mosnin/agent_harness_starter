import { describe, it, expect } from "vitest";
import {
  assertAuthenticated,
  assertSameUser,
  convexActingIdentity,
  convexAdminKey,
  isOwnedBy,
  requireOwnedSubject,
} from "../db/convex/auth";
import { mapConvexMessage, mapConvexRun, mapConvexThread } from "../db/convex/map";

describe("Convex acting identity", () => {
  it("builds a hades issuer/subject pair from the HTTP user", () => {
    expect(convexActingIdentity("user_abc")).toEqual({
      issuer: "hades",
      subject: "user_abc",
    });
  });

  it("refuses a blank userId so admin auth cannot act as nobody", () => {
    expect(() => convexActingIdentity("")).toThrow(/userId/);
    expect(() => convexActingIdentity("   ")).toThrow(/userId/);
  });
});

describe("Convex identity gates", () => {
  it("rejects missing identity", () => {
    expect(() => assertAuthenticated(null)).toThrow("Not authenticated");
    expect(() => assertAuthenticated({ subject: "" })).toThrow("Not authenticated");
  });

  it("rejects a spoofed userId that does not match the subject", () => {
    expect(() => assertSameUser("user_a", "user_b")).toThrow("Unauthorized");
    expect(() => requireOwnedSubject("user_a", "user_b")).toThrow("Unauthorized");
    expect(isOwnedBy("user_a", "user_a")).toBe(true);
    expect(isOwnedBy(undefined, "user_a")).toBe(false);
  });

  it("prefers CONVEX_ADMIN_KEY over the deploy key", () => {
    expect(convexAdminKey({ CONVEX_ADMIN_KEY: "admin", CONVEX_DEPLOY_KEY: "deploy" })).toBe(
      "admin"
    );
    expect(convexAdminKey({ CONVEX_DEPLOY_KEY: "deploy" })).toBe("deploy");
    expect(convexAdminKey({})).toBeUndefined();
  });
});

describe("Convex document mapping", () => {
  it("maps _id / _creationTime so HTTP routes see AgentThread.id", () => {
    const thread = mapConvexThread({
      _id: "k17abc",
      userId: "user_a",
      title: "chat",
      _creationTime: 1_700_000_000_000,
      updatedAt: 1_700_000_100_000,
    });
    expect(thread.id).toBe("k17abc");
    expect(thread.userId).toBe("user_a");
    expect(thread.createdAt.getTime()).toBe(1_700_000_000_000);
    expect(thread.updatedAt.getTime()).toBe(1_700_000_100_000);
  });

  it("maps messages and runs the same way", () => {
    const message = mapConvexMessage({
      _id: "m1",
      threadId: "t1",
      role: "user",
      content: "hi",
      _creationTime: 10,
    });
    expect(message.id).toBe("m1");
    expect(message.threadId).toBe("t1");
    const run = mapConvexRun({
      _id: "r1",
      threadId: "t1",
      status: "running",
      agentName: "hades",
      _creationTime: 20,
      metadata: "{\"k\":1}",
    });
    expect(run.id).toBe("r1");
    expect(run.metadata).toEqual({ k: 1 });
  });
});
