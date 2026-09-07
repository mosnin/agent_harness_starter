import { describe, expect, it, vi } from "vitest";
import {
  HadesBrowserClient,
  BrowserToolError,
  type BrowserConnection,
} from "../browser/client";
import { PROTOCOL_VERSION, type Envelope } from "../protocol";

/**
 * A stand-in for the browser at the other end of the bridge. It answers
 * envelopes the way the real agent service does, which is what lets these
 * tests cover the handshake, tool dispatch and refusal paths without an
 * Electron process.
 */
class FakeBrowser implements BrowserConnection {
  isOpen = true;
  readonly received: Envelope[] = [];
  #messageListener: ((data: string) => void) | null = null;
  #closeListener: (() => void) | null = null;

  constructor(
    private readonly respond: (
      envelope: Envelope,
      browser: FakeBrowser,
    ) => unknown | undefined,
  ) {}

  send(data: string): void {
    const envelope = JSON.parse(data) as Envelope;
    this.received.push(envelope);
    if (envelope.kind !== "request") return;
    const payload = this.respond(envelope, this);
    if (payload === undefined) return;
    this.reply(envelope, payload);
  }

  reply(request: Envelope, payload: unknown): void {
    this.deliver({
      id: `res_${request.id}`,
      protocol: PROTOCOL_VERSION,
      kind: "response",
      type: `${request.type}.result`,
      at: Date.now(),
      payload,
      replyTo: request.id,
    });
  }

  /** Push an unsolicited event, the way the browser sends captures and chat. */
  deliver(envelope: Envelope): void {
    queueMicrotask(() => this.#messageListener?.(JSON.stringify(envelope)));
  }

  close(): void {
    this.isOpen = false;
    this.#closeListener?.();
  }

  onMessage(listener: (data: string) => void): void {
    this.#messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.#closeListener = listener;
  }

  sent(type: string): Envelope | undefined {
    return this.received.find((envelope) => envelope.type === type);
  }
}

const AGENTS = [{ id: "hermes-1", name: "Hermes", allowedTools: [] }];

/** Connect once and report the URL the transport was asked to open. */
async function connectUrl(options: {
  token: string;
  url?: string;
}): Promise<string> {
  const seen: string[] = [];
  const client = new HadesBrowserClient({
    ...options,
    agents: AGENTS,
    connect: async (url) => {
      seen.push(url);
      return new FakeBrowser((envelope) =>
        envelope.type === "handshake" ? handshakeOk() : { ok: true },
      );
    },
  });
  await client.connect();
  return seen[0]!;
}

function handshakeOk(protocol: string = PROTOCOL_VERSION) {
  return {
    ok: true,
    sessionId: "sess-1",
    protocol,
    serverCapabilities: ["tools", "capture", "collections"],
  };
}

async function connected(
  respond: (envelope: Envelope, browser: FakeBrowser) => unknown | undefined,
  extra: Partial<ConstructorParameters<typeof HadesBrowserClient>[0]> = {},
): Promise<{ client: HadesBrowserClient; browser: FakeBrowser }> {
  let browser!: FakeBrowser;
  const client = new HadesBrowserClient({
    token: "pair-token",
    agents: AGENTS,
    requestTimeoutMs: 500,
    connect: async () => {
      browser = new FakeBrowser(respond);
      return browser;
    },
    ...extra,
  });
  await client.connect();
  return { client, browser };
}

describe("HadesBrowserClient handshake", () => {
  it("passes the pairing token in the connect URL", async () => {
    const seen: string[] = [];
    const client = new HadesBrowserClient({
      token: "secret token/with?chars",
      agents: AGENTS,
      connect: async (url) => {
        seen.push(url);
        return new FakeBrowser((envelope) =>
          envelope.type === "handshake" ? handshakeOk() : { ok: true },
        );
      },
    });
    await client.connect();
    expect(seen[0]).toContain("token=secret%20token%2Fwith%3Fchars");
  });

  it("defaults to the browser's loopback listener", async () => {
    const saved = process.env.HADES_BROWSER_URL;
    delete process.env.HADES_BROWSER_URL;
    try {
      const seen = await connectUrl({ token: "t" });
      expect(seen.startsWith("ws://127.0.0.1:8787?")).toBe(true);
    } finally {
      if (saved !== undefined) process.env.HADES_BROWSER_URL = saved;
    }
  });

  it("prefers HADES_BROWSER_URL over the loopback default", async () => {
    const saved = process.env.HADES_BROWSER_URL;
    process.env.HADES_BROWSER_URL = "ws://127.0.0.1:9999";
    try {
      expect(await connectUrl({ token: "t" })).toContain(
        "ws://127.0.0.1:9999?",
      );
    } finally {
      if (saved === undefined) delete process.env.HADES_BROWSER_URL;
      else process.env.HADES_BROWSER_URL = saved;
    }
  });

  it("prefers an explicit url over the environment", async () => {
    const saved = process.env.HADES_BROWSER_URL;
    process.env.HADES_BROWSER_URL = "ws://127.0.0.1:9999";
    try {
      const seen = await connectUrl({ token: "t", url: "ws://127.0.0.1:7777" });
      expect(seen).toContain("ws://127.0.0.1:7777?");
    } finally {
      if (saved === undefined) delete process.env.HADES_BROWSER_URL;
      else process.env.HADES_BROWSER_URL = saved;
    }
  });

  it("announces its agents right after the handshake", async () => {
    const { browser } = await connected((envelope) =>
      envelope.type === "handshake" ? handshakeOk() : { ok: true },
    );
    const announce = browser.sent("agents.announce");
    expect(announce?.payload).toEqual({ agents: AGENTS });
  });

  it("keeps the session id from the handshake", async () => {
    const { client, browser } = await connected((envelope) =>
      envelope.type === "handshake" ? handshakeOk() : { ok: true },
    );
    expect(client.sessionId).toBe("sess-1");
    expect(browser.sent("agents.announce")?.sessionId).toBe("sess-1");
  });

  it("refuses a browser on an incompatible major version", async () => {
    const client = new HadesBrowserClient({
      token: "t",
      agents: AGENTS,
      connect: async () =>
        new FakeBrowser((envelope) =>
          envelope.type === "handshake" ? handshakeOk("2.0.0") : { ok: true },
        ),
    });
    await expect(client.connect()).rejects.toThrow(/Protocol mismatch/);
  });

  it("surfaces a refused handshake rather than pretending to be connected", async () => {
    const client = new HadesBrowserClient({
      token: "wrong",
      agents: AGENTS,
      connect: async () =>
        new FakeBrowser(() => ({
          ok: false,
          sessionId: "",
          protocol: PROTOCOL_VERSION,
          serverCapabilities: [],
          error: "Bad pairing token",
        })),
    });
    await expect(client.connect()).rejects.toThrow(/Bad pairing token/);
  });
});

describe("HadesBrowserClient tool calls", () => {
  const respond = (envelope: Envelope) => {
    if (envelope.type === "handshake") return handshakeOk();
    if (envelope.type === "agents.announce") return { ok: true };
    if (envelope.type === "tool.call") {
      const call = envelope.payload as {
        callId: string;
        name: string;
        args: Record<string, unknown>;
      };
      if (call.name === "browser.listTabs") {
        return {
          callId: call.callId,
          ok: true,
          value: {
            tabs: [
              {
                id: "t1",
                workspaceId: "w1",
                url: "https://a.com",
                title: "A",
                pinned: false,
                lastActiveAt: 0,
              },
            ],
          },
        };
      }
      if (call.name === "activity.digest") {
        return {
          callId: call.callId,
          ok: false,
          error: {
            code: "blocked-by-policy",
            message: "Activity tracking is switched off.",
          },
        };
      }
      return {
        callId: call.callId,
        ok: false,
        error: { code: "not-found", message: "Unknown tool." },
      };
    }
    return { ok: true };
  };

  it("round-trips a tool call and unwraps the value", async () => {
    const { client } = await connected(respond);
    const result = await client.listTabs("hermes-1");
    expect(result.tabs).toHaveLength(1);
    expect(result.tabs[0]!.url).toBe("https://a.com");
  });

  it("carries the calling agent's id so the browser can check consent", async () => {
    const { client, browser } = await connected(respond);
    await client.listTabs("hermes-1");
    const call = browser.sent("tool.call")!.payload as { agentId: string };
    expect(call.agentId).toBe("hermes-1");
  });

  it("opens tabs in the background unless told otherwise", async () => {
    const { client, browser } = await connected(respond);
    await client
      .openTab("hermes-1", "https://example.com")
      .catch(() => undefined);
    const call = browser.sent("tool.call")!.payload as {
      args: { background: boolean };
    };
    expect(call.args.background).toBe(true);
  });

  it("turns a consent refusal into a typed error, not a silent undefined", async () => {
    const { client } = await connected(respond);
    await expect(client.activityDigest("hermes-1")).rejects.toBeInstanceOf(
      BrowserToolError,
    );
    await expect(client.activityDigest("hermes-1")).rejects.toMatchObject({
      code: "blocked-by-policy",
    });
  });

  it("times out rather than hanging when the browser never answers", async () => {
    const { client } = await connected((envelope) => {
      if (envelope.type === "handshake") return handshakeOk();
      if (envelope.type === "agents.announce") return { ok: true };
      return undefined;
    });
    await expect(client.listTabs("hermes-1")).rejects.toThrow(/timed out/);
  });

  it("rejects in-flight calls when the connection drops", async () => {
    const { client, browser } = await connected((envelope) => {
      if (envelope.type === "handshake") return handshakeOk();
      if (envelope.type === "agents.announce") return { ok: true };
      return undefined;
    });
    const pending = client.listTabs("hermes-1");
    browser.close();
    await expect(pending).rejects.toThrow(/closed/);
  });

  it("refuses to call a tool before connecting", async () => {
    const client = new HadesBrowserClient({ token: "t", agents: AGENTS });
    await expect(client.listTabs("hermes-1")).rejects.toThrow(/Not connected/);
  });
});

describe("HadesBrowserClient inbound events", () => {
  it("hands a user-initiated capture to onCapture", async () => {
    const onCapture = vi.fn();
    let browser!: FakeBrowser;
    const client = new HadesBrowserClient({
      token: "t",
      agents: AGENTS,
      onCapture,
      connect: async () => {
        browser = new FakeBrowser((envelope) =>
          envelope.type === "handshake" ? handshakeOk() : { ok: true },
        );
        return browser;
      },
    });
    await client.connect();

    browser.deliver({
      id: "e1",
      protocol: PROTOCOL_VERSION,
      kind: "event",
      type: "capture.submit",
      at: Date.now(),
      payload: {
        capture: {
          id: "c1",
          kind: "tab",
          dataUrl: "data:image/png;base64,AA",
          width: 1,
          height: 1,
          capturedAt: 0,
        },
        prompt: "what is this",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onCapture).toHaveBeenCalledOnce();
    expect(onCapture.mock.calls[0]![0].prompt).toBe("what is this");
  });

  it("ignores a malformed frame instead of throwing", async () => {
    const { browser } = await connected((envelope) =>
      envelope.type === "handshake" ? handshakeOk() : { ok: true },
    );
    expect(() => {
      // The client registers one message listener; feed it rubbish directly.
      browser.deliver({} as Envelope);
    }).not.toThrow();
  });
});

describe("answering the browser's Max requests", () => {
  /** Send `ai.complete` from the browser side and wait for the reply. */
  async function askBrowserSide(
    browser: FakeBrowser,
    payload: unknown,
  ): Promise<{ ok: boolean; text: string; error?: string }> {
    const id = "req_ai_1";
    browser.deliver({
      id,
      protocol: PROTOCOL_VERSION,
      kind: "request",
      type: "ai.complete",
      at: Date.now(),
      payload,
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      const reply = browser.received.find(
        (envelope) => envelope.kind === "response" && envelope.replyTo === id,
      );
      if (reply)
        return reply.payload as { ok: boolean; text: string; error?: string };
    }
    throw new Error("no response to ai.complete");
  }

  it("answers with the handler's text", async () => {
    const { browser } = await connected(
      (envelope) =>
        envelope.type === "handshake" ? handshakeOk() : { ok: true },
      { onComplete: (request) => `answered ${request.task}` },
    );
    await expect(askBrowserSide(browser, { task: "preview" })).resolves.toEqual(
      {
        ok: true,
        text: "answered preview",
      },
    );
  });

  it("says so when no handler is configured, rather than going quiet", async () => {
    // The browser holds a promise open for this; a silent drop turns a
    // missing feature into a thirty-second stall behind a spinner.
    const { browser } = await connected((envelope) =>
      envelope.type === "handshake" ? handshakeOk() : { ok: true },
    );
    const reply = await askBrowserSide(browser, { task: "preview" });
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/does not answer/i);
  });

  it("reports a handler that threw instead of hanging", async () => {
    const { browser } = await connected(
      (envelope) =>
        envelope.type === "handshake" ? handshakeOk() : { ok: true },
      {
        onComplete: () => {
          throw new Error("model unavailable");
        },
      },
    );
    const reply = await askBrowserSide(browser, { task: "ask" });
    expect(reply).toMatchObject({ ok: false, error: "model unavailable" });
  });

  it("refuses a request type it does not implement", async () => {
    const { browser } = await connected((envelope) =>
      envelope.type === "handshake" ? handshakeOk() : { ok: true },
    );
    const id = "req_unknown";
    browser.deliver({
      id,
      protocol: PROTOCOL_VERSION,
      kind: "request",
      type: "something.else",
      at: Date.now(),
      payload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const reply = browser.received.find((envelope) => envelope.replyTo === id);
    expect(reply?.payload).toMatchObject({ ok: false });
  });
});

describe("agent mode over the bridge", () => {
  it("sends page actions as tool calls carrying the run id, and unwraps the result", async () => {
    const { client, browser } = await connected((envelope) => {
      if (envelope.type === "handshake") return handshakeOk();
      if (envelope.type === "agents.announce") return { ok: true };
      if (envelope.type === "tool.call") {
        const call = envelope.payload as {
          name: string;
          runId?: string;
          args: Record<string, unknown>;
        };
        if (call.name === "page.click") {
          return {
            callId: "c",
            ok: true,
            value: { ok: true, url: "https://a.example/next", navigated: true },
          };
        }
        if (call.name === "page.snapshot") {
          return {
            callId: "c",
            ok: true,
            value: {
              snapshotId: 1,
              tabId: call.args.tabId,
              url: "u",
              title: "t",
              nodes: [],
              truncated: false,
            },
          };
        }
      }
      return undefined;
    });
    const tree = await client.snapshot("hermes-1", "tab-1", { runId: "run-1" });
    expect(tree.snapshotId).toBe(1);
    const result = await client.click("hermes-1", "tab-1", "r3", {
      runId: "run-1",
    });
    expect(result.navigated).toBe(true);
    const calls = browser.received.filter(
      (envelope) => envelope.type === "tool.call",
    );
    expect(calls).toHaveLength(2);
    expect(
      calls.every(
        (envelope) =>
          (envelope.payload as { runId?: string }).runId === "run-1",
      ),
    ).toBe(true);
  });

  it("surfaces a paused or declined action as a refusal the model can read", async () => {
    const { client } = await connected((envelope) => {
      if (envelope.type === "handshake") return handshakeOk();
      if (envelope.type === "agents.announce") return { ok: true };
      if (envelope.type === "tool.call") {
        return {
          callId: "c",
          ok: false,
          error: { code: "paused", message: "The person is using this page." },
        };
      }
      return undefined;
    });
    await expect(
      client.type("hermes-1", "tab-1", "r1", "hello"),
    ).rejects.toMatchObject({
      code: "paused",
      message: "The person is using this page.",
    });
  });

  it("reports a run's life as events and hears the person's control back", async () => {
    const controls: unknown[] = [];
    const { client, browser } = await connected(
      (envelope) => {
        if (envelope.type === "handshake") return handshakeOk();
        if (envelope.type === "agents.announce") return { ok: true };
        return undefined;
      },
      { onTaskControl: (control) => controls.push(control) },
    );
    client.startRun({
      runId: "run-1",
      agentId: "hermes-1",
      title: "Book a table",
      threadId: "thr-1",
    });
    client.reportStep({
      runId: "run-1",
      stepId: "s1",
      text: "Opening the site",
      status: "running",
    });
    client.askUser("run-1", "Which time?", ["7pm", "8pm"]);
    client.finishRun("run-1", "done", "Booked for 8.", [
      { kind: "tab", id: "t1", label: "Booking" },
    ]);
    expect(browser.received.map((envelope) => envelope.type)).toEqual(
      expect.arrayContaining([
        "task.started",
        "task.step",
        "task.needsInput",
        "task.finished",
      ]),
    );
    expect(browser.sent("task.needsInput")?.payload).toMatchObject({
      question: { prompt: "Which time?", options: ["7pm", "8pm"] },
    });

    browser.deliver({
      id: "evt-1",
      protocol: PROTOCOL_VERSION,
      kind: "event",
      type: "task.control",
      at: Date.now(),
      payload: { runId: "run-1", action: "pause", reason: "user-input" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controls).toEqual([
      { runId: "run-1", action: "pause", reason: "user-input" },
    ]);
  });

  it("hands the thread id along with a chat turn so the reply lands in the right conversation", async () => {
    const chats: unknown[] = [];
    const { browser } = await connected(
      (envelope) => {
        if (envelope.type === "handshake") return handshakeOk();
        if (envelope.type === "agents.announce") return { ok: true };
        return undefined;
      },
      { onChat: (message) => chats.push(message) },
    );
    browser.deliver({
      id: "evt-2",
      protocol: PROTOCOL_VERSION,
      kind: "event",
      type: "chat.send",
      at: Date.now(),
      payload: {
        text: "hi",
        agentId: "hermes-1",
        threadId: "thr-9",
        context: { selection: "quoted" },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chats).toEqual([
      {
        text: "hi",
        agentId: "hermes-1",
        threadId: "thr-9",
        context: { selection: "quoted" },
      },
    ]);
  });
});
