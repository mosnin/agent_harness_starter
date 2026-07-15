import { randomUUID } from "node:crypto";
import type { AcpTransport } from "./transport";
import {
  ACP_PROTOCOL_VERSION,
  RpcErrors,
  type ContentBlock,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type NewSessionParams,
  type PromptParams,
  type PromptResult,
  type SessionUpdate,
} from "./types";

export interface AcpSession {
  id: string;
  cwd?: string;
  createdAt: number;
  turns: number;
  cancelled: boolean;
}

/** Context handed to the prompt handler: the turn's input + a streaming sink. */
export interface AcpPromptContext {
  sessionId: string;
  prompt: ContentBlock[];
  /** Stream a `session/update` notification to the client. */
  emit: (update: SessionUpdate) => Promise<void>;
  /** Cooperative cancellation — the handler should check this between steps. */
  isCancelled: () => boolean;
}

export type AcpPromptHandler = (ctx: AcpPromptContext) => Promise<PromptResult>;

export interface AcpServerOptions {
  onPrompt: AcpPromptHandler;
  newSessionId?: () => string;
  now?: () => number;
  agentCapabilities?: InitializeResult["agentCapabilities"];
}

function isRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return "method" in m && "id" in m && (m as JsonRpcRequest).id !== undefined;
}

/**
 * ACP agent-side server. It answers the editor's JSON-RPC over an injectable
 * transport: `initialize` handshake, `session/new`, `session/prompt` (delegating
 * to an injectable handler that streams `session/update` notifications back), and
 * the `session/cancel` notification. The prompt handler is where a real
 * deployment drives the swarm; the server just owns the protocol + session model.
 */
export class AcpServer {
  private sessions = new Map<string, AcpSession>();
  private readonly newSessionId: () => string;
  private readonly now: () => number;
  private initialized = false;

  constructor(
    private readonly transport: AcpTransport,
    private readonly opts: AcpServerOptions
  ) {
    this.newSessionId = opts.newSessionId ?? (() => randomUUID());
    this.now = opts.now ?? (() => Date.now());
  }

  /** Begin serving: wire the transport's inbound handler. */
  start(): void {
    this.transport.onMessage((m) => void this.dispatch(m));
  }

  session(id: string): AcpSession | undefined {
    return this.sessions.get(id);
  }
  sessionCount(): number {
    return this.sessions.size;
  }

  private async reply(id: JsonRpcRequest["id"], result: unknown): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", id, result });
  }
  private async replyError(id: JsonRpcRequest["id"], code: number, message: string): Promise<void> {
    await this.transport.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private async dispatch(message: JsonRpcMessage): Promise<void> {
    // Notifications (no id) — only session/cancel is meaningful to the agent.
    if (!isRequest(message)) {
      if ("method" in message && message.method === "session/cancel") {
        const p = message.params as { sessionId?: string } | undefined;
        const s = p?.sessionId ? this.sessions.get(p.sessionId) : undefined;
        if (s) s.cancelled = true;
      }
      return;
    }

    try {
      switch (message.method) {
        case "initialize":
          this.initialized = true;
          await this.reply(message.id, {
            protocolVersion: ACP_PROTOCOL_VERSION,
            agentCapabilities: this.opts.agentCapabilities ?? { promptCapabilities: {}, editApproval: false },
          } satisfies InitializeResult);
          return;

        case "session/new": {
          if (!this.initialized) return this.replyError(message.id, RpcErrors.InvalidRequest, "not initialized");
          const params = (message.params ?? {}) as NewSessionParams;
          const id = this.newSessionId();
          this.sessions.set(id, { id, cwd: params.cwd, createdAt: this.now(), turns: 0, cancelled: false });
          await this.reply(message.id, { sessionId: id });
          return;
        }

        case "session/prompt": {
          const params = message.params as PromptParams | undefined;
          const session = params?.sessionId ? this.sessions.get(params.sessionId) : undefined;
          if (!session) return this.replyError(message.id, RpcErrors.InvalidParams, "unknown session");
          session.cancelled = false;
          session.turns++;

          const emit = async (update: SessionUpdate): Promise<void> => {
            await this.transport.send({
              jsonrpc: "2.0",
              method: "session/update",
              params: { sessionId: session.id, update },
            });
          };
          const result = await this.opts.onPrompt({
            sessionId: session.id,
            prompt: params?.prompt ?? [],
            emit,
            isCancelled: () => session.cancelled,
          });
          await this.reply(message.id, session.cancelled ? { stopReason: "cancelled" } : result);
          return;
        }

        default:
          await this.replyError(message.id, RpcErrors.MethodNotFound, `unknown method: ${message.method}`);
      }
    } catch (err) {
      await this.replyError(message.id, RpcErrors.InternalError, err instanceof Error ? err.message : String(err));
    }
  }
}
