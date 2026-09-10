import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
import type { ChatRequest, ModelClient } from "../../hades/models/client";
vi.mock("../core/webhook-service", async () => ({
  WebhookService: (await import("./fixtures/offline-webhooks"))
    .OfflineWebhookFixture,
}));

const roots: string[] = [],
  services: WorkbenchService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "hades-work-offline-"));
  roots.push(root);
  const requests: Array<
      ChatRequest & { selectedProfile: string; selectedModel: string }
    > = [],
    events: any[] = [];
  const s = new WorkbenchService(
    join(root, "data"),
    (event) => events.push(event),
    {
      NODE_ENV: "test",
      HADES_COMPANY_OS_BUNDLE: join(
        process.cwd(),
        "third_party/company-os/bundle.json",
      ),
    },
  );
  services.push(s);
  vi.spyOn(
    s as unknown as {
      client: (p: { id: string; model: string }) => ModelClient;
    },
    "client",
  ).mockImplementation((profile) => ({
    chat: async (input: ChatRequest) => {
      requests.push({
        ...input,
        messages: input.messages.map((message) => ({ ...message })),
        selectedProfile: profile.id,
        selectedModel: profile.model,
      });
      const last = input.messages.at(-1)?.content ?? "";
      const text = /^TOOL_(RESULT|ERROR):/.test(last)
        ? "ANSWER: Completed the assigned task."
        : `TOOL: file_ops\nINPUT: ${JSON.stringify({ op: "write", path: profile.model === "producer" ? "first.txt" : "second.txt", content: profile.model === "producer" ? "FIRST" : "SECOND" })}`;
      return {
        text,
        tokensIn: 10,
        tokensOut: 5,
        usd: 0,
        model: profile.model,
        provider: "offline-fixture",
        costMeasured: false,
      };
    },
  }));
  await s.dispatch("project.add", { path: root });
  await s.dispatch("profile.save", {
    id: "default",
    name: "Producer",
    provider: "local",
    model: "producer",
    baseUrl: "https://unused.invalid/v1",
  });
  const peer = (await s.dispatch("profile.save", {
    name: "Reviewer",
    provider: "local",
    model: "reviewer",
    baseUrl: "https://unused.invalid/v1",
  })) as { id: string };
  await s.dispatch("profile.select", { id: "default" });
  return { root, s, events, requests, peer: peer.id };
}
it("runs a dependent multi-profile plan through actual conversations, approvals and durable output checks", async () => {
  const { root, s, events, requests, peer } = await setup();
  const goal: any = await s.dispatch("work.create", {
    root,
    objective: "Produce two checked outputs",
    tasks: [
      {
        id: "first",
        title: "First",
        prompt: "Create FIRST",
        profile: "default",
        acceptance: [{ path: "first.txt", contains: "FIRST" }],
      },
      {
        id: "second",
        title: "Second",
        prompt: "Verify first then create SECOND",
        profile: peer,
        dependsOn: ["first"],
        acceptance: [{ path: "second.txt", contains: "SECOND" }],
      },
    ],
    acceptance: [
      { path: "first.txt", contains: "FIRST" },
      { path: "second.txt", contains: "SECOND" },
    ],
  });
  await s.dispatch("work.run", { id: goal.id });
  await vi.waitFor(() =>
    expect(events.filter((e) => e.kind === "desktop.approval")).toHaveLength(1),
  );
  expect(requests.every((r) => r.selectedModel === "producer")).toBe(true);
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  await s.dispatch("approval.reply", {
    id: events.find((e) => e.kind === "desktop.approval").id,
    allow: true,
  });
  await vi.waitFor(() =>
    expect(events.filter((e) => e.kind === "desktop.approval")).toHaveLength(2),
  );
  expect(
    requests
      .find((r) => r.selectedModel === "reviewer")!
      .messages.some((m: any) =>
        m.content.includes("Completed dependency reports"),
      ),
  ).toBe(true);
  await s.dispatch("approval.reply", {
    id: events.filter((e) => e.kind === "desktop.approval")[1].id,
    allow: true,
  });
  await vi.waitFor(async () =>
    expect(await s.dispatch("work.get", { id: goal.id })).toMatchObject({
      status: "completed",
    }),
  );
  const done: any = await s.dispatch("work.get", { id: goal.id });
  expect(requests).toHaveLength(4);
  expect(
    requests
      .filter((r) => r.selectedModel === "reviewer")
      .every((r) => r.selectedProfile === peer),
  ).toBe(true);
  expect(
    done.tasks.every((t: any) => !t.engine || t.engine.kind === "hades"),
  ).toBe(true);
  expect(done.tasks.every((t: any) => t.evidence?.length === 1)).toBe(true);
  expect(
    requests
      .find((r) => r.selectedModel === "reviewer")!
      .messages.some((m) => m.content.includes("Checked artifact receipts")),
  ).toBe(true);
  expect(done.tokens).toBe(60);
  expect(done.evidence).toHaveLength(2);
  expect(done.evidence.every((e: any) => /^[a-f0-9]{64}$/.test(e.sha256))).toBe(
    true,
  );
  expect(readFileSync(join(root, "second.txt"), "utf8")).toBe("SECOND");
  await expect(
    s.dispatch("work.get", { id: goal.id, profile: peer }),
  ).rejects.toThrow("another profile");
  s.close();
  const restored = new WorkbenchService(join(root, "data"), () => {}, {
    NODE_ENV: "test",
    HADES_COMPANY_OS_BUNDLE: join(
      process.cwd(),
      "third_party/company-os/bundle.json",
    ),
  });
  services.push(restored);
  expect(await restored.dispatch("work.get", { id: goal.id })).toMatchObject({
    status: "completed",
    evidence: done.evidence,
  });
  const transcript: any = await restored.dispatch("session.get", {
    id: done.tasks[0].session,
  });
  expect(
    transcript.progress.tools.some(
      (e: any) => e.tool === "file_ops" && e.status === "done",
    ),
  ).toBe(true);
});
it("stopping a plan cancels its live approval and cannot authorize the write afterward", async () => {
  const { root, s, events } = await setup();
  const goal: any = await s.dispatch("work.create", {
    root,
    objective: "Stop before effect",
    tasks: [{ title: "First", prompt: "Create FIRST" }],
    acceptance: [{ path: "first.txt" }],
  });
  await s.dispatch("work.run", { id: goal.id });
  await vi.waitFor(() =>
    expect(events.some((e) => e.kind === "desktop.approval")).toBe(true),
  );
  const approval = events.find((e) => e.kind === "desktop.approval");
  await s.dispatch("work.stop", { id: goal.id });
  await s.dispatch("approval.reply", { id: approval.id, allow: true });
  await vi.waitFor(() =>
    expect(events.some((e) => e.kind === "desktop.done")).toBe(true),
  );
  expect(existsSync(join(root, "first.txt"))).toBe(false);
  expect(await s.dispatch("work.get", { id: goal.id })).toMatchObject({
    status: "cancelled",
  });
});
