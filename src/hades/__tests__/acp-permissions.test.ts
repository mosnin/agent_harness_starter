import { describe, it, expect } from "vitest";
import {
  EditApprovalManager,
  PermissionPolicy,
  ProvenanceLog,
} from "../acp/permissions";
import type { RequestPermissionFn, EditRequest } from "../acp/permissions";
import { AcpServer } from "../acp/server";
import { InMemoryAcpTransport } from "../acp/transport";
import { ACP_PROTOCOL_VERSION } from "../acp/types";
import type { JsonRpcMessage, JsonRpcRequest, JsonRpcResponse } from "../acp/types";

const edit: EditRequest = { path: "src/app.ts", kind: "modify", description: "add a route" };

function selecting(optionId: string): RequestPermissionFn {
  return async () => ({ outcome: { outcome: "selected", optionId } });
}

describe("EditApprovalManager", () => {
  it("approves once and logs provenance", async () => {
    let t = 100;
    const prov = new ProvenanceLog(() => t++);
    const mgr = new EditApprovalManager(selecting("allow_once"), { provenance: prov });

    const d = await mgr.requestApproval("s1", edit);
    expect(d).toMatchObject({ allowed: true, scope: "once", remembered: false });
    expect(prov.forSession("s1").map((e) => e.decision)).toEqual(["approved"]);
  });

  it("remembers allow_always and stops prompting", async () => {
    let prompts = 0;
    const request: RequestPermissionFn = async () => {
      prompts++;
      return { outcome: { outcome: "selected", optionId: "allow_always" } };
    };
    const policy = new PermissionPolicy();
    const mgr = new EditApprovalManager(request, { policy });

    const first = await mgr.requestApproval("s1", edit);
    expect(first).toMatchObject({ allowed: true, scope: "always", remembered: false });

    const second = await mgr.requestApproval("s1", edit);
    expect(second).toMatchObject({ allowed: true, scope: "always", remembered: true });
    expect(prompts).toBe(1); // second was auto-answered
    expect(mgr.log.forPath("src/app.ts").map((e) => e.decision)).toEqual(["approved", "auto-approved"]);
  });

  it("remembers reject_always as a denial", async () => {
    const mgr = new EditApprovalManager(selecting("reject_always"));
    const first = await mgr.requestApproval("s1", edit);
    expect(first.allowed).toBe(false);
    const second = await mgr.requestApproval("s1", edit);
    expect(second).toMatchObject({ allowed: false, remembered: true });
  });

  it("treats a cancelled outcome as a one-time denial", async () => {
    const mgr = new EditApprovalManager(async () => ({ outcome: { outcome: "cancelled" } }));
    const d = await mgr.requestApproval("s1", edit);
    expect(d).toMatchObject({ allowed: false, scope: "once", remembered: false });
    expect(mgr.log.all()[0].decision).toBe("cancelled");
  });

  it("records an applied edit after approval", async () => {
    const mgr = new EditApprovalManager(selecting("allow_once"));
    await mgr.requestApproval("s1", edit);
    mgr.recordApplied("s1", edit);
    expect(mgr.log.forSession("s1").map((e) => e.decision)).toEqual(["approved", "applied"]);
  });
});

describe("ACP edit-approval over the transport (integration)", () => {
  it("agent requests permission mid-prompt and the client grants it", async () => {
    const [agentSide, clientSide] = InMemoryAcpTransport.pair();

    // Client that auto-answers session/request_permission with allow_once.
    let nextId = 1;
    const pending = new Map<number | string, (r: JsonRpcResponse) => void>();
    clientSide.onMessage((m: JsonRpcMessage) => {
      if ("method" in m && "id" in m && (m as JsonRpcRequest).id !== undefined) {
        const req = m as JsonRpcRequest;
        if (req.method === "session/request_permission") {
          void clientSide.send({
            jsonrpc: "2.0",
            id: req.id,
            result: { outcome: { outcome: "selected", optionId: "allow_once" } },
          });
        }
      } else if (!("method" in m) && (m as JsonRpcResponse).id !== undefined) {
        pending.get((m as JsonRpcResponse).id)?.(m as JsonRpcResponse);
      }
    });
    const clientRequest = (method: string, params?: unknown) =>
      new Promise<JsonRpcResponse>((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        void clientSide.send({ jsonrpc: "2.0", id, method, params });
      });

    const prov = new ProvenanceLog(() => 1);
    const server = new AcpServer(agentSide, {
      newSessionId: () => "s1",
      now: () => 1,
      onPrompt: async (ctx) => {
        const approvals = new EditApprovalManager(
          (params) => ctx.sendRequest("session/request_permission", params) as ReturnType<RequestPermissionFn>,
          { provenance: prov }
        );
        const decision = await approvals.requestApproval(ctx.sessionId, edit);
        if (decision.allowed) approvals.recordApplied(ctx.sessionId, edit);
        return { stopReason: "end_turn" };
      },
    });
    server.start();

    await clientRequest("initialize", { protocolVersion: ACP_PROTOCOL_VERSION });
    await clientRequest("session/new", {});
    const res = await clientRequest("session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "edit" }] });

    expect(res.result).toEqual({ stopReason: "end_turn" });
    expect(prov.forSession("s1").map((e) => e.decision)).toEqual(["approved", "applied"]);
  });
});
