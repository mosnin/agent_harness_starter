import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import {
  HadesBrowserClient,
  BROWSER_PROTOCOL,
} from "../core/hades-browser-client";
import { HelmPreview } from "../core/helm-preview";
import { HelmSourceChecks } from "../core/helm-source-checks";
import { MausCompanion } from "../core/maus-companion";
import { WorkbenchService } from "../core/workbench-service";
import type { DesktopMcpServer } from "../core/mcp-stdio";
import type { SpatialPacket } from "../core/spatial-context";

const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const captureId = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const dirs: string[] = [],
  services: WorkbenchService[] = [];
afterEach(() => {
  services.splice(0).forEach((service) => service.close());
  vi.restoreAllMocks();
  dirs
    .splice(0)
    .forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-cross-app-")));
  dirs.push(dir);
  return dir;
}
/** A strict native-protocol fixture, not a mock of MausCompanion or connectMcp.
 * Native schema pointers: HMToolArguments.swift HMGetContextArguments /
 * HMRequestPointingArguments; HMToolDispatcher.summary(of:) and diffCaptures. */
function nativeFixture(mode = "capture", marker?: string): DesktopMcpServer {
  const source = `
 const readline=require('node:readline');const fs=require('node:fs');
 const mode=${JSON.stringify(mode)},marker=${JSON.stringify(marker)},image=${JSON.stringify(image.split(",")[1])};
 const names=['hadesmaus_request_pointing','hadesmaus_get_context','hadesmaus_diff_captures'];
 readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;let result;
 if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'native-contract-fixture',version:'1'}};
 else if(m.method==='tools/list')result={tools:mode==='missing'?[]:names.map(name=>({name,inputSchema:{type:'object'}}))};
 else {
 const a=m.params.arguments,name=m.params.name;if(marker)fs.writeFileSync(marker,'dispatched');
 if(mode==='hang')return;
 const invalid=name==='hadesmaus_request_pointing' ? typeof a.question!=='string'||a.question.length>200||a.timeoutMs!==120000||a.allowVoice!==true : name==='hadesmaus_get_context' ? a.count!==1||a.maxVisionTokens!==3000||JSON.stringify(a.include)!==JSON.stringify(['crops','windowText','axTree']) : !a.captureId||!a.baselineCaptureId;
 if(invalid)result={isError:true,content:[{type:'text',text:'Native argument schema mismatch'}]};
 else if(mode==='refusal')result={content:[{type:'text',text:'User declined pointing. No capture produced.'}]};
 else if(mode==='error')result={isError:true,content:[{type:'text',text:'Accessibility permission not granted'}]};
 else if(name==='hadesmaus_diff_captures')result={content:[{type:'text',text:'Fixture structural comparison'}],structuredContent:{beforeCaptureId:a.baselineCaptureId,afterCaptureId:a.captureId,windowsCompared:1,windowsRefused:0,elementChanges:1,layoutFindings:1,unchanged:false}};
 else result={content:[{type:'text',text:'UNTRUSTED_FIXTURE_SCREEN_TEXT'},{type:'image',mimeType:mode==='invalid-image'?'image/svg+xml':'image/png',data:image}],structuredContent:{captures:[{captureId:mode==='after'?'cap_01ARZ3NDEKTSV4RRFFQ69G5FAW':'${captureId}',createdAt:'2026-09-10T00:00:00Z',kind:'region',title:'Synthetic button'}]}};
 }
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
 });`;
  return {
    name: "native_fixture",
    command: process.execPath,
    args: ["-e", source],
    enabled: true,
  };
}
async function workbench() {
  const dir = directory(),
    root = join(dir, "project");
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
  const binary = join(dir, "fixture-codex");
  writeFileSync(
    binary,
    `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--version'))console.log('fixture');else{const i=process.argv.indexOf('--image');if(i<0||!fs.readFileSync(process.argv[i+1]).length)throw Error('Reviewed image missing');fs.writeFileSync('index.html','<button style="padding: 16px">Save</button>');console.log(JSON.stringify({type:'turn.completed'}));}`,
  );
  chmodSync(binary, 0o700);
  const events: Record<string, unknown>[] = [];
  const service = new WorkbenchService(
    join(dir, "data"),
    (e) => events.push(e as unknown as Record<string, unknown>),
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
  const session = (await service.dispatch("session.new", { root })) as {
    id: string;
  };
  const scope = { root, sessionId: session.id, profile: "default" };
  vi.spyOn(
    service as unknown as { spatialMcp(profile: string): DesktopMcpServer },
    "spatialMcp",
  ).mockReturnValue(nativeFixture());
  return { dir, root, scope, service, events };
}
it.each(["point", "latest"])(
  "real MCP transport accepts native %s arguments and structured capture summary",
  async (mode) => {
    const maus = new MausCompanion({
        NODE_ENV: "test",
        HADES_MAUS_APP: "/nonexistent-fixture",
      }),
      abort = new AbortController();
    try {
      const result = await maus.capture(
        directory(),
        abort.signal,
        nativeFixture(),
        mode,
        "Select this button",
      );
      expect(result.context.captureId).toBe(captureId);
      expect(result.images).toEqual([image]);
      expect(JSON.stringify(result.context)).not.toContain(image.split(",")[1]);
    } finally {
      abort.abort();
      maus.close();
    }
  },
);
it.each(["refusal", "error", "invalid-image", "missing"])(
  "real native %s response cannot become a successful packet",
  async (mode) => {
    const maus = new MausCompanion({
        NODE_ENV: "test",
        HADES_MAUS_APP: "/nonexistent-fixture",
      }),
      abort = new AbortController();
    try {
      await expect(
        maus.capture(
          directory(),
          abort.signal,
          nativeFixture(mode),
          "point",
          "Point",
        ),
      ).rejects.toThrow();
    } finally {
      abort.abort();
      maus.close();
    }
  },
);
it("missing bundled bridge fails before any native action; cancellation closes a pending real stdio request", async () => {
  const dir = directory(),
    marker = join(dir, "dispatched"),
    maus = new MausCompanion({
      NODE_ENV: "test",
      HADES_MAUS_APP: join(dir, "missing.app"),
    });
  expect(maus.status().available).toBe(false);
  await expect(
    maus.capture(
      dir,
      new AbortController().signal,
      undefined,
      "point",
      "Point",
    ),
  ).rejects.toThrow(/not bundled/);
  const abort = new AbortController(),
    pending = maus.capture(
      dir,
      abort.signal,
      nativeFixture("hang", marker),
      "point",
      "Point",
    );
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
  abort.abort();
  await rejected;
  maus.close();
});
it("real MCP image reaches a session-owned review, immutable Helm draft and isolated CLI run", async () => {
  const { service, scope, root, events } = await workbench();
  const requests: any[] = [];
  vi.spyOn(
    service as unknown as { client(...args: unknown[]): unknown },
    "client",
  ).mockReturnValue({
    chat: async (request: unknown) => {
      requests.push(request);
      return {
        text: "ANSWER: Reviewed fixture image.",
        tokensIn: 1,
        tokensOut: 1,
        usd: 0,
        model: "fixture",
        provider: "fixture",
      };
    },
  });
  const packet = (await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
    mode: "latest",
  })) as SpatialPacket;
  expect(packet.images).toEqual([image]);
  expect(packet.context.captureId).toBe(captureId);
  await expect(
    service.dispatch("spatial.handoff", {
      ...scope,
      ...{ id: packet.id, revision: packet.revision },
      prompt: "Fix spacing",
    }),
  ).rejects.toThrow(/Review/);
  const reviewed = (await service.dispatch("spatial.review", {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    intent: "Fix spacing",
  })) as SpatialPacket;
  await service.dispatch("chat.send", {
    id: scope.sessionId,
    profile: scope.profile,
    input: "Review the spacing",
    spatialIds: [{ id: reviewed.id, revision: reviewed.revision }],
  });
  await vi.waitFor(() =>
    expect(
      events.some(
        (e) => e.kind === "desktop.done" && e.session === scope.sessionId,
      ),
    ).toBe(true),
  );
  expect(
    requests.flatMap((r) => r.messages).some((m) => m.images?.includes(image)),
  ).toBe(true);
  const args = {
    ...scope,
    id: reviewed.id,
    revision: reviewed.revision,
    prompt: "Fix spacing",
  };
  const draft = (await service.dispatch("spatial.handoff", args)) as {
    id: string;
  };
  expect(await service.dispatch("spatial.handoff", args)).toEqual(draft);
  await expect(
    service.dispatch("spatial.remove", {
      ...scope,
      id: reviewed.id,
      revision: reviewed.revision,
    }),
  ).rejects.toThrow();
  const run = (await service.dispatch("helm.start", {
    root,
    profile: scope.profile,
    agent: "codex",
    prompt: "Fix spacing",
    handoffId: draft.id,
    maxMinutes: 1,
  })) as { id: string };
  let final:
    | {
        status: string;
        workspace: string;
        parentSession: string;
        handoffId: string;
      }
    | undefined;
  await vi.waitFor(
    async () => {
      final = (await service.dispatch("helm.get", {
        id: run.id,
        profile: scope.profile,
      })) as typeof final;
      expect(final?.status).toBe("needs_review");
    },
    { timeout: 5000 },
  );
  expect(final?.parentSession).toBe(scope.sessionId);
  expect(final?.handoffId).toBe(draft.id);
  expect(readFileSync(join(root, "index.html"), "utf8")).toBe(
    "<button>Save</button>",
  );
  expect(readFileSync(join(final!.workspace, "index.html"), "utf8")).toContain(
    "padding: 16px",
  );
  await expect(
    service.dispatch("helm.start", {
      root,
      profile: scope.profile,
      agent: "codex",
      prompt: "Fix spacing",
      handoffId: draft.id,
      maxMinutes: 1,
    }),
  ).rejects.toThrow();
  // Isolate the native-provenance gate after an explicitly synthetic source-check receipt.
  vi.spyOn(HelmSourceChecks.prototype, "get").mockResolvedValue({
    runId: run.id,
    root,
    status: "passed",
    after: "synthetic-source-check",
  } as Awaited<ReturnType<HelmSourceChecks["get"]>>);
  await expect(
    service.dispatch("helm.preview.open", {
      id: run.id,
      profile: scope.profile,
      requestId: randomUUID(),
      sourceCheckId: randomUUID(),
      url: "http://localhost:3000/",
    }),
  ).rejects.toThrow(/no originating Browser space/);
});
it("review exclusions remove native image and screen text from the actual chat request", async () => {
  const { service, scope, events } = await workbench();
  const requests: unknown[] = [];
  vi.spyOn(
    service as unknown as { client(...args: unknown[]): unknown },
    "client",
  ).mockReturnValue({
    chat: async (request: unknown) => {
      requests.push(request);
      return {
        text: "ANSWER: Done.",
        tokensIn: 1,
        tokensOut: 1,
        usd: 0,
        model: "fixture",
        provider: "fixture",
      };
    },
  });
  const packet = (await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
  })) as SpatialPacket;
  const reviewed = (await service.dispatch("spatial.review", {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    intent: "Text-only instruction",
    excludeText: true,
    excludeImage: true,
  })) as SpatialPacket;
  await service.dispatch("chat.send", {
    id: scope.sessionId,
    profile: scope.profile,
    input: "Fix spacing",
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
  expect(JSON.stringify(requests)).not.toContain(
    "UNTRUSTED_FIXTURE_SCREEN_TEXT",
  );
  expect(JSON.stringify(requests)).not.toContain(image.split(",")[1]);
  const other = (await service.dispatch("session.new", {
    root: scope.root,
  })) as { id: string };
  await expect(
    service.dispatch("spatial.get", {
      ...scope,
      sessionId: other.id,
      id: packet.id,
    }),
  ).rejects.toThrow(/own/);
});
it.each(["ref", "workspaceId", "screenshot"])(
  "rejects malformed Browser %s identity or pixel metadata",
  async (field) => {
    const { service, scope } = await workbench();
    const value: Record<string, unknown> = {
      tabId: "tab",
      workspaceId: "space",
      ref: "s7r0",
      snapshotId: 7,
      capturedAt: Date.now(),
      url: "http://localhost/",
      boxCss: { x: 0, y: 0, width: 20, height: 20 },
      viewport: {
        width: 100,
        height: 100,
        scrollX: 0,
        scrollY: 0,
        deviceScale: 2,
        visualScale: 1,
        visualOffsetX: 0,
        visualOffsetY: 0,
      },
      zoomFactor: 1,
      semantics: { role: "button", name: "Save" },
      styles: {},
      screenshot: {
        dataUrl: image,
        width: 100,
        height: 100,
        scope: "viewport",
        coordinateSpace: "top-viewport-css",
      },
    };
    if (field === "ref") value.ref = "s7r9";
    if (field === "workspaceId") delete value.workspaceId;
    if (field === "screenshot")
      value.screenshot = {
        dataUrl: image,
        width: -1,
        height: "invalid",
        scope: "screen",
      };
    vi.spyOn(
      service as unknown as { spatialBrowser(...args: unknown[]): unknown },
      "spatialBrowser",
    ).mockReturnValue({ call: async () => ({ ok: true, value }) });
    await expect(
      service.dispatch("spatial.capture", {
        ...scope,
        source: "browser",
        tabId: "tab",
        ref: "s7r0",
        snapshotId: 7,
      }),
    ).rejects.toThrow();
    expect(await service.dispatch("spatial.list", scope)).toEqual([]);
  },
);

it("native diff summary is correlated to the requested capture identities through real MCP", async () => {
  const maus = new MausCompanion(),
    abort = new AbortController();
  try {
    const after = "cap_01ARZ3NDEKTSV4RRFFQ69G5FAW";
    const result = await maus.diff(
      directory(),
      abort.signal,
      nativeFixture(),
      captureId,
      after,
    );
    expect(result.comparable).toBe(true);
    expect(result.summary).toMatchObject({
      beforeCaptureId: captureId,
      afterCaptureId: after,
      windowsCompared: 1,
      unchanged: false,
    });
  } finally {
    abort.abort();
    maus.close();
  }
});

async function browserTransport() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((r) => server.once("listening", r));
  const records: any[] = [];
  let gap = "8px";
  server.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      records.push(frame);
      if (frame.kind !== "request") return;
      let payload: any;
      if (frame.type === "handshake")
        payload = {
          ok: true,
          protocol: BROWSER_PROTOCOL,
          sessionId: "fixture",
          serverCapabilities: ["tools", "page", "runs"],
        };
      else if (frame.type === "agents.announce") payload = { ok: true };
      else if (frame.type === "tool.call") {
        const { name, args, callId } = frame.payload;
        let value: any;
        if (name === "page.spatialContext")
          value = {
            tabId: args.tabId,
            workspaceId: "space",
            ref: args.ref,
            snapshotId: args.snapshotId,
            capturedAt: Date.now(),
            url: "http://localhost:3000/",
            boxCss: { x: 0, y: 0, width: 20, height: 20 },
            viewport: {
              width: 100,
              height: 100,
              scrollX: 0,
              scrollY: 0,
              deviceScale: 2,
              visualScale: 1,
              visualOffsetX: 0,
              visualOffsetY: 0,
            },
            zoomFactor: 1,
            semantics: { role: "button", name: "Save" },
            styles: { gap },
            source: {
              file: "index.html",
              line: 1,
              provenance: "developer-attribute-unverified",
            },
            screenshot: {
              dataUrl: image,
              width: 200,
              height: 200,
              scope: "viewport",
              coordinateSpace: "top-viewport-css",
            },
          };
        else if (name === "workflow.control")
          value = {
            workflows: [
              {
                id: "workflow",
                status: args.operation === "stop" ? "ready" : "recording",
              },
            ],
          };
        else if (name === "browser.openTab")
          value = {
            tab: {
              id: "preview-tab",
              workspaceId: args.workspaceId,
              url: args.url,
            },
          };
        payload = { callId, ok: true, value };
      }
      socket.send(
        JSON.stringify({
          id: randomUUID(),
          protocol: BROWSER_PROTOCOL,
          kind: "response",
          type: frame.type + ".result",
          at: Date.now(),
          replyTo: frame.id,
          sessionId: frame.sessionId,
          payload,
        }),
      );
    }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture socket");
  const client = new HadesBrowserClient({
    endpoint: "ws://127.0.0.1:" + address.port,
    token: "synthetic-pairing-token-only",
    agents: [
      {
        id: "agent",
        profile: "default",
        name: "Fixture",
        allowedTools: [
          "page.spatialContext",
          "workflow.control",
          "browser.openTab",
        ],
      },
    ],
  });
  await client.connect();
  return {
    client,
    records,
    setGap(value: string) {
      gap = value;
    },
    async close() {
      client.close();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
it("actual Browser WebSocket adapter preserves packet geometry, owned workflow lifetime and preview space", async () => {
  const { service, scope, dir } = await workbench(),
    browser = await browserTransport();
  try {
    vi.spyOn(
      service as unknown as { spatialBrowser(...args: unknown[]): unknown },
      "spatialBrowser",
    ).mockReturnValue(browser.client);
    const capture = () =>
      service.dispatch("spatial.capture", {
        ...scope,
        source: "browser",
        tabId: "tab",
        ref: "s7r0",
        snapshotId: 7,
      }) as Promise<SpatialPacket>;
    const before = await capture();
    expect(before.context.imageGeometry).toEqual({
      width: 200,
      height: 200,
      scope: "viewport",
      coordinateSpace: "top-viewport-css",
    });
    expect(before.context.sourceEvidence).toMatchObject({
      file: "index.html",
      componentMatch: "unverified",
    });
    expect(JSON.stringify(before.context)).not.toContain(image.split(",")[1]);
    browser.setGap("16px");
    const after = await capture();
    // Structural comparison only here; native pixel helper is separately tested.
    for (const packet of [before, after])
      await service.dispatch("spatial.review", {
        ...scope,
        id: packet.id,
        revision: packet.revision,
        intent: "Compare layout",
        excludeImage: true,
      });
    const compare = (await service.dispatch("spatial.compare", {
      ...scope,
      beforeId: before.id,
      afterId: after.id,
    })) as { comparable: boolean; changes: unknown[] };
    expect(compare.comparable).toBe(true);
    expect(compare.changes).toContainEqual({
      path: "styles.gap",
      before: "8px",
      after: "16px",
    });
    for (const operation of ["start", "status", "stop"])
      await service.dispatch("spatial.workflow", {
        ...scope,
        tabId: "tab",
        operation,
        ...(operation === "start" ? {} : { workflowId: "workflow" }),
      });
    const calls = browser.records.filter(
      (r) => r.type === "tool.call" && r.payload.name === "workflow.control",
    );
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((r) => r.payload.runId)).size).toBe(1);
    const preview = new HelmPreview(dir, {
      context: async () => ({
        workspaceId: "space",
        profile: "default",
        sourceRevision: "synthetic-checked-source",
      }),
      client: () => browser.client,
    });
    const requestId = randomUUID(),
      receipt = await preview.open(
        requestId,
        "fixture-helm-run",
        "fixture-source-check",
        { root: scope.root, owner: scope.profile },
        "http://localhost:3000/",
      );
    expect(receipt.status).toBe("opened");
    expect(receipt.workspaceId).toBe("space");
    expect(
      await preview.open(
        requestId,
        "fixture-helm-run",
        "fixture-source-check",
        { root: scope.root, owner: scope.profile },
        "http://localhost:3000/",
      ),
    ).toEqual(receipt);
    expect(
      browser.records.filter(
        (r) => r.type === "tool.call" && r.payload.name === "browser.openTab",
      ),
    ).toHaveLength(1);
  } finally {
    await browser.close();
  }
});

it("closing MausCompanion cancels active configured MCP calls and refuses later dispatch", async () => {
  const dir = directory(),
    marker = join(dir, "dispatch"),
    abort = new AbortController(),
    maus = new MausCompanion();
  const pending = maus.capture(
    dir,
    abort.signal,
    nativeFixture("hang", marker),
    "point",
    "Point",
  );
  const settled = pending.then(
    () => "resolved",
    () => "rejected",
  );
  try {
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
    maus.close();
    expect(
      await Promise.race([
        settled,
        new Promise((r) => setTimeout(() => r("still pending"), 300)),
      ]),
    ).toBe("rejected");
    const lateMarker = join(dir, "late");
    await expect(
      maus.capture(
        dir,
        new AbortController().signal,
        nativeFixture("capture", lateMarker),
        "point",
        "Point",
      ),
    ).rejects.toThrow(/clos/i);
    expect(existsSync(lateMarker)).toBe(false);
  } finally {
    abort.abort();
    maus.close();
    await settled;
  }
});
it("native comparison uses pixel evidence and reports unknown when no image pair remains", async () => {
  const { service, scope } = await workbench();
  const before = (await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
    mode: "latest",
  })) as SpatialPacket;
  vi.mocked(
    (service as unknown as { spatialMcp(profile: string): DesktopMcpServer })
      .spatialMcp,
  ).mockReturnValue(nativeFixture("after"));
  const after = (await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
    mode: "latest",
  })) as SpatialPacket;
  expect(before.id).not.toBe(after.id);
  expect(before.images).toEqual(after.images);
  // Explicit image-processor fixture; actual Swift identical-pixel oracle lives in spatial-images-native.test.ts.
  const processImages = vi.fn(async () => ({
    comparable: true,
    changedPixels: 0,
    changedFraction: 0,
  }));
  (
    service as unknown as { spatial: { processImages: unknown } }
  ).spatial.processImages = processImages;
  const result = (await service.dispatch("spatial.compare", {
    ...scope,
    beforeId: before.id,
    afterId: after.id,
  })) as { imageChanged: boolean | null };
  expect(result.imageChanged).toBe(false);
  expect(processImages).toHaveBeenCalledWith("diff", [image, image]);
  await service.dispatch("spatial.review", {
    ...scope,
    id: after.id,
    revision: after.revision,
    intent: "Exclude pixels",
    excludeImage: true,
  });
  const withoutPixels = (await service.dispatch("spatial.compare", {
    ...scope,
    beforeId: before.id,
    afterId: after.id,
  })) as { imageChanged: boolean | null };
  expect(withoutPixels.imageChanged).toBeNull();
  expect(processImages).toHaveBeenCalledTimes(1);
});

it("quota recovery removes only the current unshared capture in its owning conversation", async () => {
  const { service, scope, dir } = await workbench();
  const packet = (await service.dispatch("spatial.capture", {
    ...scope,
    source: "maus",
  })) as SpatialPacket;
  const reviewed = (await service.dispatch("spatial.review", {
    ...scope,
    id: packet.id,
    revision: packet.revision,
    intent: "Keep private",
  })) as SpatialPacket;
  await expect(
    service.dispatch("spatial.remove", {
      ...scope,
      id: packet.id,
      revision: packet.revision,
    }),
  ).rejects.toThrow();
  const other = (await service.dispatch("session.new", {
    root: scope.root,
  })) as { id: string };
  await expect(
    service.dispatch("spatial.remove", {
      ...scope,
      sessionId: other.id,
      id: reviewed.id,
      revision: reviewed.revision,
    }),
  ).rejects.toThrow(/own/);
  await service.dispatch("spatial.remove", {
    ...scope,
    id: reviewed.id,
    revision: reviewed.revision,
  });
  expect(await service.dispatch("spatial.list", scope)).toEqual([]);
  expect(existsSync(join(dir, "data", "spatial", packet.id + ".json"))).toBe(
    false,
  );
  expect(
    existsSync(join(dir, "data", "spatial", packet.id + ".summary.json")),
  ).toBe(false);
});
