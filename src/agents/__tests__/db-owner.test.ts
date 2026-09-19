import { describe, it, expect } from "vitest";
import { createMemoryAdapter } from "../db/memory";
import { assertOwned, ownedOrNull } from "../db/owner";
import { MAX_STORED_MESSAGE_CHARS } from "../lib/thread-history";
import { MAX_LIST_MESSAGES, MAX_LIST_THREADS } from "../lib/request-guard";

describe("ownedOrNull / assertOwned", () => {
  it("hides a foreign row and refuses a foreign write", () => {
    expect(ownedOrNull({ id: "t1" }, "u1", "u2")).toBeNull();
    expect(ownedOrNull({ id: "t1" }, "u1", "u1")).toEqual({ id: "t1" });
    expect(ownedOrNull({ id: "t1" }, "u1", undefined)).toEqual({ id: "t1" });
    expect(() => assertOwned("u1", "u2", "delete")).toThrow(/Unauthorized/);
  });
});

describe("memory adapter ownership", () => {
  it("returns null for another user's thread and refuses their writes", async () => {
    const db = createMemoryAdapter();
    const mine = await db.createThread("u1", "mine");
    const theirs = await db.createThread("u2", "theirs");

    expect(await db.getThread(theirs.id, "u1")).toBeNull();
    expect((await db.getThread(mine.id, "u1"))?.title).toBe("mine");
    expect(await db.getMessages(theirs.id, "u1")).toEqual([]);

    await expect(
      db.saveMessage({ threadId: theirs.id, role: "user", content: "hi" }, "u1")
    ).rejects.toThrow(/Unauthorized/);

    await expect(db.deleteThread(theirs.id, "u1")).rejects.toThrow(/Unauthorized/);
    expect(await db.getThread(theirs.id, "u2")).not.toBeNull();

    const run = await db.createRun(
      { threadId: mine.id, status: "running", agentName: "hades" },
      "u1"
    );
    expect(await db.getRun(run.id, "u2")).toBeNull();
    await db.deleteThread(mine.id, "u1");
    expect(await db.getThread(mine.id, "u1")).toBeNull();
    expect(await db.getRun(run.id, "u1")).toBeNull();
  });

  it("returns only the most recent N messages when a limit is set", async () => {
    const db = createMemoryAdapter();
    const thread = await db.createThread("u1", "long");
    for (let i = 0; i < 5; i++) {
      await db.saveMessage({ threadId: thread.id, role: "user", content: `m${i}` }, "u1");
    }
    const tail = await db.getMessages(thread.id, "u1", { limit: 2 });
    expect(tail.map((row) => row.content)).toEqual(["m3", "m4"]);
    expect((await db.getMessages(thread.id, "u1")).length).toBe(5);
  });

  it("returns only the newest N threads when a limit is set", async () => {
    const db = createMemoryAdapter();
    for (let i = 0; i < 5; i++) {
      await db.createThread("u1", `t${i}`);
    }
    const newest = await db.listThreads("u1", { limit: 2 });
    expect(newest).toHaveLength(2);
    expect((await db.listThreads("u1")).length).toBe(5);
    expect(await db.listThreads("u1", { limit: 0 })).toEqual([]);
  });

  it("defaults omitted list limits so a store dump cannot grow unbounded", async () => {
    const db = createMemoryAdapter();
    for (let i = 0; i < MAX_LIST_THREADS + 3; i += 1) {
      await db.createThread("u1", `t${i}`);
    }
    expect((await db.listThreads("u1")).length).toBe(MAX_LIST_THREADS);
    const thread = await db.createThread("u2", "long");
    for (let i = 0; i < MAX_LIST_MESSAGES + 4; i += 1) {
      await db.saveMessage({ threadId: thread.id, role: "user", content: `m${i}` }, "u2");
    }
    const tail = await db.getMessages(thread.id, "u2");
    expect(tail).toHaveLength(MAX_LIST_MESSAGES);
    expect(tail[0]?.content).toBe(`m${4}`);
    expect(tail[tail.length - 1]?.content).toBe(`m${MAX_LIST_MESSAGES + 3}`);
  });

  it("clamps oversized message content before store", async () => {
    const db = createMemoryAdapter();
    const thread = await db.createThread("u1", "big");
    const saved = await db.saveMessage(
      { threadId: thread.id, role: "user", content: "x".repeat(MAX_STORED_MESSAGE_CHARS + 40) },
      "u1"
    );
    expect(saved.content.length).toBe(MAX_STORED_MESSAGE_CHARS + 1);
    expect(saved.content.endsWith("…")).toBe(true);
  });
});
