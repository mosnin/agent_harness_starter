import {
  PROTOCOL_VERSION,
  isCompatible,
  nextMessageId,
  type ActivityDigest,
  type AgentDescriptor,
  type BrowserTab,
  type BrowserToolName,
  type BrowserWorkspace,
  type CaptureSubmission,
  type CollectionSearchHit,
  type CollectionSummary,
  type Envelope,
  type HandshakeRequest,
  type HandshakeResponse,
  type PageContent,
  type ToolCall,
  type ToolResult,
} from "../protocol";

/**
 * Client for the Hades Browser's agent bridge.
 *
 * The browser listens on loopback and gates on a pairing token the user copies
 * out of its settings, so this connects to a browser on the same machine —
 * which is the point: browsing data never crosses a network to reach an agent.
 */

export interface BrowserConnection {
  send(data: string): void;
  close(): void;
  onMessage(listener: (data: string) => void): void;
  onClose(listener: () => void): void;
  readonly isOpen: boolean;
}

export interface HadesBrowserClientOptions {
  /** Defaults to HADES_BROWSER_URL, then ws://127.0.0.1:8787. */
  url?: string;
  /** Pairing token from the browser's Settings → Agents panel. */
  token: string;
  agents: AgentDescriptor[];
  requestTimeoutMs?: number;
  /** Supply a transport; the default opens a WebSocket. */
  connect?: (url: string) => Promise<BrowserConnection>;
  /** Called when the browser sends a capture the user took. */
  onCapture?: (submission: CaptureSubmission) => void;
  /** Called when the user types into the browser's agent panel. */
  onChat?: (message: { text: string; agentId?: string }) => void;
}

interface Pending {
  resolve: (envelope: Envelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class HadesBrowserClient {
  readonly #options: HadesBrowserClientOptions;
  readonly #pending = new Map<string, Pending>();
  #connection: BrowserConnection | null = null;
  #sessionId: string | undefined;

  constructor(options: HadesBrowserClientOptions) {
    this.#options = options;
  }

  get isConnected(): boolean {
    return this.#connection?.isOpen ?? false;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async connect(): Promise<HandshakeResponse> {
    const base = this.#options.url ?? process.env.HADES_BROWSER_URL ?? "ws://127.0.0.1:8787";
    // The token travels in the query string because the browser checks it
    // during the WebSocket upgrade, before any frame is accepted.
    const url = `${base}?token=${encodeURIComponent(this.#options.token)}`;
    const connect = this.#options.connect ?? defaultConnect;
    const connection = await connect(url);
    this.#connection = connection;

    connection.onMessage((data) => this.#receive(data));
    connection.onClose(() => {
      this.#connection = null;
      this.#failAll(new Error("The browser connection closed."));
    });

    const handshake: HandshakeRequest = {
      protocol: PROTOCOL_VERSION,
      client: "hermes-harness",
      clientVersion: "0.1.0",
      capabilities: ["tools", "capture", "activity", "collections", "wallet"],
    };
    const response = await this.#request<HandshakeResponse>("handshake", handshake);
    if (!response.ok) throw new Error(response.error ?? "The browser refused the handshake.");
    if (!isCompatible(response.protocol)) {
      throw new Error(
        `Protocol mismatch: the browser speaks ${response.protocol}, this harness speaks ${PROTOCOL_VERSION}.`,
      );
    }
    this.#sessionId = response.sessionId;
    await this.#request("agents.announce", { agents: this.#options.agents });
    return response;
  }

  disconnect(): void {
    this.#connection?.close();
    this.#connection = null;
    this.#failAll(new Error("Disconnected."));
  }

  // ── Browser tools ─────────────────────────────────────────────────────────

  async callTool<T>(agentId: string, name: BrowserToolName, args: Record<string, unknown> = {}): Promise<T> {
    const call: ToolCall = { callId: nextMessageId("call"), agentId, name, args };
    const result = await this.#request<ToolResult<T>>("tool.call", call);
    if (!result.ok) {
      throw new BrowserToolError(result.error?.code ?? "internal", result.error?.message ?? "The tool failed.");
    }
    return result.value as T;
  }

  listWorkspaces(agentId: string): Promise<{ workspaces: BrowserWorkspace[] }> {
    return this.callTool(agentId, "browser.listWorkspaces");
  }

  listTabs(agentId: string, workspaceId?: string): Promise<{ tabs: BrowserTab[] }> {
    return this.callTool(agentId, "browser.listTabs", workspaceId ? { workspaceId } : {});
  }

  openTab(agentId: string, url: string, options: { workspaceId?: string; background?: boolean } = {}) {
    return this.callTool<{ tab: BrowserTab }>(agentId, "browser.openTab", {
      url,
      background: options.background ?? true,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    });
  }

  readPage(
    agentId: string,
    tabId: string,
    options: { format?: "text" | "markdown" | "html"; maxLength?: number } = {},
  ): Promise<PageContent> {
    return this.callTool(agentId, "browser.readPage", { tabId, ...options });
  }

  listCollections(agentId: string): Promise<{ collections: CollectionSummary[] }> {
    return this.callTool(agentId, "collections.list");
  }

  searchCollections(
    agentId: string,
    query: string,
    options: { limit?: number; collectionIds?: string[] } = {},
  ): Promise<{ hits: CollectionSearchHit[] }> {
    return this.callTool(agentId, "collections.search", { query, ...options });
  }

  activityDigest(agentId: string, fromMs?: number, toMs?: number): Promise<{ digest: ActivityDigest }> {
    return this.callTool(agentId, "activity.digest", { fromMs, toMs });
  }

  // ── Outbound ──────────────────────────────────────────────────────────────

  /** Push a chat turn into the browser's agent panel. */
  sendMessage(message: { agentId: string; content: string; streamId?: string; final?: boolean }): void {
    this.#emit("agent.message", { role: "assistant", ...message });
  }

  /** Ask the user to approve something, shown as a sheet in the browser. */
  requestApproval(request: {
    approvalId: string;
    agentId: string;
    summary: string;
    detail?: string;
    risk: "low" | "medium" | "high";
  }): void {
    this.#emit("approval.request", request);
  }

  notify(title: string, body?: string): void {
    this.#emit("notification", { title, body });
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  #request<R>(type: string, payload: unknown): Promise<R> {
    const connection = this.#connection;
    if (!connection?.isOpen) return Promise.reject(new Error("Not connected to a Hades browser."));

    const envelope: Envelope = {
      id: nextMessageId("req"),
      protocol: PROTOCOL_VERSION,
      kind: "request",
      type,
      at: Date.now(),
      payload,
      sessionId: this.#sessionId,
    };
    const timeoutMs = this.#options.requestTimeoutMs ?? 30_000;

    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(envelope.id);
        reject(new Error(`"${type}" timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      // A pending request must never hold the process open on its own.
      timer.unref?.();
      this.#pending.set(envelope.id, {
        resolve: (response) => {
          const body = response.payload as { error?: string } | R;
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
            reject(new Error(body.error));
            return;
          }
          resolve(body as R);
        },
        reject,
        timer,
      });
      connection.send(JSON.stringify(envelope));
    });
  }

  #emit(type: string, payload: unknown): void {
    if (!this.#connection?.isOpen) return;
    this.#connection.send(
      JSON.stringify({
        id: nextMessageId("evt"),
        protocol: PROTOCOL_VERSION,
        kind: "event",
        type,
        at: Date.now(),
        payload,
        sessionId: this.#sessionId,
      } satisfies Envelope),
    );
  }

  #receive(data: string): void {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data) as Envelope;
    } catch {
      return;
    }
    if (typeof envelope?.id !== "string" || typeof envelope.type !== "string") return;

    if (envelope.kind === "response" && envelope.replyTo) {
      const pending = this.#pending.get(envelope.replyTo);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(envelope.replyTo);
      pending.resolve(envelope);
      return;
    }

    if (envelope.kind !== "event") return;
    if (envelope.type === "capture.submit") {
      this.#options.onCapture?.(envelope.payload as CaptureSubmission);
    }
    if (envelope.type === "chat.send") {
      this.#options.onChat?.(envelope.payload as { text: string; agentId?: string });
    }
  }

  #failAll(error: Error): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }
}

export class BrowserToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BrowserToolError";
  }
}

/** `ws` is an optional dependency, matching how the harness loads its other adapters. */
async function defaultConnect(url: string): Promise<BrowserConnection> {
  const { default: WebSocket } = await import("ws");
  const socket = new WebSocket(url);

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });

  return {
    get isOpen() {
      return socket.readyState === socket.OPEN;
    },
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onMessage: (listener) => socket.on("message", (raw: unknown) => listener(String(raw))),
    onClose: (listener) => socket.on("close", () => listener()),
  };
}
