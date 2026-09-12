import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExternalConversations } from "../core/external-conversations";
const dirs: string[] = [];
afterEach(() =>
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true })),
);
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "external-hades-"));
  dirs.push(dir);
  const session = {
    id: "session",
    profile: "owner",
    root: "/project",
    messages: [],
    delegatedWork: ["work"],
    helmRuns: ["helm"],
    orcaIntents: [{ id: "orca" }],
  };
  const rpc = vi.fn(
    async (method: string, args: Record<string, unknown>): Promise<any> => {
      if (method === "session.new")
        return { id: session.id, root: session.root };
      if (method === "session.get") return session;
      if (method === "work.stop") throw new Error("Work is still stopping");
      return { id: args.id, status: "running" };
    },
  );
  return { dir, rpc, service: new ExternalConversations(dir, rpc) };
}
it("recovers admission without replay and preserves explicit profile identity", async () => {
  const f = fixture(),
    request = {
      operation: "delegate",
      requestId: "once",
      input: "Build a report",
      profile: "owner",
    };
  const first: any = await f.service.call(request);
  expect(first.admission).toBe("started");
  expect(f.rpc).toHaveBeenCalledWith(
    "chat.send",
    expect.objectContaining({ profile: "owner", id: "session" }),
  );
  const recovered = new ExternalConversations(f.dir, f.rpc);
  const again: any = await recovered.call(request);
  expect(again.id).toBe(first.id);
  expect(
    f.rpc.mock.calls.filter(([method]) => method === "chat.send"),
  ).toHaveLength(1);
  expect(again.orca).toEqual([{ id: "orca", status: "running" }]);
});
it("attempts every child cancellation and reports a partial failure", async () => {
  const f = fixture();
  const first: any = await f.service.call({
    operation: "delegate",
    requestId: "once",
    input: "Build a report",
  });
  const result: any = await f.service.call({
    operation: "cancel",
    id: first.id,
  });
  expect(result.cancellation).toEqual([
    expect.objectContaining({ id: "work", status: "rejected" }),
    { id: "helm", status: "fulfilled" },
    { id: "orca", status: "fulfilled" },
  ]);
  expect(f.rpc).toHaveBeenCalledWith(
    "helm.orca.stop",
    expect.objectContaining({ id: "orca", profile: "owner" }),
  );
});
it("records a failed send without retrying it when its request ID is replayed", async () => {
  const f = fixture();
  f.rpc.mockImplementation(async (method) => {
    if (method === "session.new") return { id: "session" };
    if (method === "session.get")
      return { id: "session", profile: "owner", messages: [] };
    if (method === "chat.send") throw new Error("Provider unavailable");
    return {};
  });
  const request = {
    operation: "delegate",
    requestId: "once",
    input: "Build a report",
  };
  expect(await f.service.call(request)).toMatchObject({
    admission: "failed",
    error: "Provider unavailable",
  });
  await f.service.call(request);
  expect(
    f.rpc.mock.calls.filter(([method]) => method === "chat.send"),
  ).toHaveLength(1);
});

it("preserves cancellation receipts when a child status cannot be read", async () => {
  const f = fixture(),
    original = f.rpc.getMockImplementation()!;
  f.rpc.mockImplementation(async (method, args) => {
    if (method === "work.get") throw new Error("Missing work record");
    return original(method, args);
  });
  const first: any = await f.service.call({
    operation: "delegate",
    requestId: "once",
    input: "Build a report",
  });
  const result: any = await f.service.call({
    operation: "cancel",
    id: first.id,
  });
  expect(result.conversation.work).toEqual([
    { id: "work", status: "unavailable", error: "Missing work record" },
  ]);
  expect(result.cancellation).toHaveLength(3);
});

it("returns an existing continuation receipt even when history is full", async () => {
  const f = fixture();
  const first: any = await f.service.call({
    operation: "delegate",
    requestId: "once",
    input: "Build a report",
  });
  const request = {
    operation: "continue",
    id: first.id,
    requestId: "next",
    input: "Verify it",
  };
  const receipt: any = await f.service.call(request);
  const path = join(f.dir, "external-conversations.json");
  const records = JSON.parse(readFileSync(path, "utf8"));
  while (records.length < 10000)
    records.push({
      ...records[0],
      id: "filler-" + records.length,
      requestId: "filler-" + records.length,
    });
  writeFileSync(path, JSON.stringify(records));
  const recovered = new ExternalConversations(f.dir, f.rpc);
  expect(await recovered.call(request)).toMatchObject({
    id: receipt.id,
    admission: "started",
  });
  expect(
    f.rpc.mock.calls.filter(([method]) => method === "chat.send"),
  ).toHaveLength(2);
  await expect(
    recovered.call({ ...request, requestId: "another" }),
  ).rejects.toThrow("history is full");
});
