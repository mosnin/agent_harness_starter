import { describe, expect, it, vi } from "vitest";
import { HadesBrowserClient, BrowserToolError, type BrowserConnection } from "../browser/client";
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
    private readonly respond: (envelope: Envelope, browser: FakeBrowser) => unknown | undefined,
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
async function connectUrl(options: { token: string; url?: string }): Promise<string> {
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
      expect(await connectUrl({ token: "t" })).toContain("ws://127.0.0.1:9999?");
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
      const call = envelope.payload as { callId: string; name: string; args: Record<string, unknown> };
      if (call.name === "browser.listTabs") {
        return {
          callId: call.callId,
          ok: true,
          value: { tabs: [{ id: "t1", workspaceId: "w1", url: "https://a.com", title: "A", pinned: false, lastActiveAt: 0 }] },
        };
      }
      if (call.name === "activity.digest") {
        return {
          callId: call.callId,
          ok: false,
          error: { code: "blocked-by-policy", message: "Activity tracking is switched off." },
        };
      }
      return { callId: call.callId, ok: false, error: { code: "not-found", message: "Unknown tool." } };
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
    await client.openTab("hermes-1", "https://example.com").catch(() => undefined);
    const call = browser.sent("tool.call")!.payload as { args: { background: boolean } };
    expect(call.args.background).toBe(true);
  });

  it("turns a consent refusal into a typed error, not a silent undefined", async () => {
    const { client } = await connected(respond);
    await expect(client.activityDigest("hermes-1")).rejects.toBeInstanceOf(BrowserToolError);
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
        capture: { id: "c1", kind: "tab", dataUrl: "data:image/png;base64,AA", width: 1, height: 1, capturedAt: 0 },
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
