import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkbenchService } from "../core/workbench-service";
import { MausCompanion } from "../core/maus-companion";
const dirs: string[] = [],
  services: WorkbenchService[] = [];
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
afterEach(() => {
  services.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-workbench-")));
  dirs.push(dir);
  const root = join(dir, "project");
  mkdirSync(root);
  writeFileSync(join(root, "index.html"), "<button>Save</button>");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
  ])
    execFileSync("git", args, { cwd: root });
  const binary = join(dir, "fake-codex");
  writeFileSync(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--version'))console.log('fixture');else{const p=process.argv[process.argv.indexOf('--image')+1];if(!p||!fs.readFileSync(p).length)throw Error('No image');fs.writeFileSync('index.html','<button style="padding: 16px">Save</button>');console.log(JSON.stringify({type:'turn.completed'}));}`,
  );
  chmodSync(binary, 0o700);
  const events: any[] = [];
  const service = new WorkbenchService(
    join(dir, "data"),
    (e) => events.push(e),
    {
      ...process.env,
      NODE_ENV: "test",
      HADES_BROWSER_RUNTIME: "0",
      HADES_WEBHOOK_PORT: "0",
      HADES_HELM_CODEX_BIN: binary,
    },
  );
  services.push(service);
  await service.dispatch("project.add", { path: root });
  const session: any = await service.dispatch("session.new", { root });
  const scope = { sessionId: session.id, profile: "default", root };
  vi.spyOn(MausCompanion.prototype, "capture").mockResolvedValue({
    context: {
      captureId: "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      captures: [],
      blocks: [{ type: "text", text: "Button misaligned" }],
    },
    images: [image],
  });
  return { service, events, root, scope, dir };
}
it("routes reviewed images and structural data to the actual chat turn while preserving explicit scope", async () => {
  const { service, scope, events } = await fixture();
  const requests: any[] = [];
  vi.spyOn(service as any, "client").mockReturnValue({
    chat: async (request: any) => {
      requests.push(request);
      return {
        text: "ANSWER: Reviewed the supplied image.",
        tokensIn: 10,
        tokensOut: 5,
        usd: 0,
        model: "fixture",
        provider: "fixture",
      };
    },
  });
  const packet: any = await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
  });
  expect(requests).toHaveLength(0);
  await expect(
    service.dispatch("chat.send", {
      id: scope.sessionId,
      profile: scope.profile,
      input: "Fix it",
      spatialIds: [{ id: packet.id, revision: packet.revision }],
    }),
  ).rejects.toThrow(/Review/);
  const reviewed: any = await service.dispatch("spatial.review", {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    intent: "Align this button",
  });
  await service.dispatch("chat.send", {
    id: scope.sessionId,
    profile: scope.profile,
    input: "Fix it",
    spatialIds: [{ id: reviewed.id, revision: reviewed.revision }],
  });
  await vi.waitFor(() =>
    expect(
      events.some(
        (e) => e.kind === "desktop.done" && e.session === scope.sessionId,
      ),
    ).toBe(true),
  );
  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.flatMap((r) => r.messages).some((m) => m.images?.includes(image)),
  ).toBe(true);
  expect(JSON.stringify(requests)).toContain("Align this button");
  expect(
    (
      (await service.dispatch("spatial.get", {
        ...scope,
        id: packet.id,
      })) as any
    ).status,
  ).toBe("attached");
  const other: any = await service.dispatch("session.new", {
    root: scope.root,
  });
  await expect(
    service.dispatch("spatial.get", {
      ...scope,
      sessionId: other.id,
      id: packet.id,
    }),
  ).rejects.toThrow(/own/);
});
it("materializes reviewed images for a real isolated CLI job and retains the source unchanged", async () => {
  const { service, scope, root } = await fixture();
  let packet: any = await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
  });
  packet = await service.dispatch("spatial.review", {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    intent: "Increase spacing",
  });
  const args = {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    prompt: "Increase button spacing",
  };
  const draft: any = await service.dispatch("spatial.handoff", args);
  expect(await service.dispatch("spatial.handoff", args)).toEqual(draft);
  const run: any = await service.dispatch("helm.start", {
    root,
    profile: scope.profile,
    agent: "codex",
    prompt: args.prompt,
    handoffId: draft.id,
    maxMinutes: 1,
  });
  let final: any;
  await vi.waitFor(
    async () => {
      final = await service.dispatch("helm.get", {
        id: run.id,
        profile: scope.profile,
      });
      expect(final.status).toBe("needs_review");
    },
    { timeout: 5000 },
  );
  expect(readFileSync(join(root, "index.html"), "utf8")).toBe(
    "<button>Save</button>",
  );
  expect(readFileSync(join(final.workspace, "index.html"), "utf8")).toContain(
    "padding: 16px",
  );
  const diff: any = await service.dispatch("helm.diff", {
    id: run.id,
    profile: scope.profile,
  });
  expect(diff.text).toContain("padding: 16px");
  expect(diff.text).not.toContain(".hades-spatial");
  expect(final.parentSession).toBe(scope.sessionId);
  expect(final.handoffId).toBe(draft.id);
});
it("does not retain a cancelled or late capture", async () => {
  const { service, scope } = await fixture();
  let finish!: (v: any) => void;
  vi.mocked(MausCompanion.prototype.capture).mockImplementation(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const pending = service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
  });
  await service.dispatch("spatial.cancel", scope);
  finish({ context: { note: "late" }, images: [image] });
  await expect(pending).rejects.toThrow();
  expect(await service.dispatch("spatial.list", scope)).toEqual([]);
});
it("forwards numeric Browser snapshot identity and rejects another profile or stale result", async () => {
  const { service, scope } = await fixture();
  const call = vi.fn(async () => ({
    ok: true,
    value: {
      tabId: "tab",
      workspaceId: "space",
      snapshotId: 7,
      ref: "s7r0",
      capturedAt: Date.now(),
      boxCss: { x: 0, y: 0, width: 20, height: 20 },
      zoomFactor: 1,
      url: "http://localhost/",
      viewport: {
        width: 100,
        height: 100,
        scrollX: 0,
        scrollY: 0,
        deviceScale: 1,
      },
      semantics: { name: "Save" },
      screenshot: {
        dataUrl: image,
        scope: "viewport",
        coordinateSpace: "top-viewport-css",
        width: 100,
        height: 100,
      },
    },
  }));
  vi.spyOn(service as any, "spatialBrowser").mockReturnValue({ call });
  const packet: any = await service.dispatch("spatial.capture", {
    ...scope,
    source: "browser",
    tabId: "tab",
    snapshotId: 7,
    ref: "s7r0",
  });
  expect(packet.context.workspaceId).toBe("space");
  expect(call.mock.calls[0]).toEqual(
    expect.arrayContaining([
      "default",
      "page.spatialContext",
      expect.objectContaining({ snapshotId: 7 }),
    ]),
  );
  await expect(
    service.dispatch("spatial.capture", {
      ...scope,
      source: "browser",
      tabId: "tab",
      snapshotId: "7",
      ref: "s7r0",
    }),
  ).rejects.toThrow(/Inspect/);
});
it("reserves workflow ownership before awaiting start and cancellation addresses the same run", async () => {
  const { service, scope } = await fixture();
  let finish!: (v: any) => void;
  const emit = vi.fn(),
    call = vi.fn(async (_p, _name, args: any, _options: any) =>
      args.operation === "start"
        ? new Promise((r) => {
            finish = r;
          })
        : { ok: true, value: { workflows: [] } },
    );
  vi.spyOn(service as any, "spatialBrowser").mockReturnValue({ call, emit });
  const pending = service.dispatch("spatial.workflow", {
    ...scope,
    tabId: "tab",
    operation: "start",
  });
  await expect(
    service.dispatch("spatial.workflow", {
      ...scope,
      tabId: "tab",
      operation: "start",
    }),
  ).rejects.toThrow(/already/);
  await service.dispatch("spatial.workflow", {
    ...scope,
    tabId: "tab",
    operation: "cancel",
  });
  expect(call.mock.calls[0][3]).toEqual(call.mock.calls[1][3]);
  finish({ ok: true, value: { workflows: [] } });
  await expect(pending).rejects.toThrow(/cancelled/);
});
