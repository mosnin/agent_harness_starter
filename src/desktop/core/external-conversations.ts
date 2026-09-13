import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
type Rpc = (method: string, args: Record<string, unknown>) => Promise<any>;
type RecordEntry = {
  id: string;
  requestId: string;
  fingerprint: string;
  session?: string;
  profile?: string;
  state: "starting" | "started" | "failed";
  error?: string;
};
/** Local authenticated clients can supervise only conversations created through this boundary.
 * No approval-reply or arbitrary desktop RPC is exported. Request IDs survive process restarts. */
export class ExternalConversations {
  private records: RecordEntry[];
  private readonly path: string;
  private pending = new Set<string>();
  constructor(
    dir: string,
    private readonly rpc: Rpc,
  ) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, "external-conversations.json");
    this.records = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : [];
  }
  private save() {
    const temp = this.path + ".tmp";
    writeFileSync(temp, JSON.stringify(this.records), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  async call(args: Record<string, unknown>): Promise<unknown> {
    const operation = args.operation;
    if (
      !["delegate", "status", "cancel", "continue"].includes(String(operation))
    )
      throw new Error("Unknown conversation operation");
    const allowed =
      operation === "delegate"
        ? ["operation", "requestId", "input", "root", "profile", "browserOnly"]
        : operation === "continue"
          ? ["operation", "id", "requestId", "input"]
          : ["operation", "id"];
    if (Object.keys(args).some((key) => !allowed.includes(key)))
      throw new Error("Unsupported conversation field");
    if (operation === "delegate") {
      const requestId = identifier(args.requestId),
        input = message(args.input);
      if (args.root !== undefined && typeof args.root !== "string")
        throw new Error("Invalid project path");
      if (args.profile !== undefined) identifier(args.profile);
      if (
        args.browserOnly !== undefined &&
        typeof args.browserOnly !== "boolean"
      )
        throw new Error("Invalid browser scope");
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            input,
            args.root ?? null,
            args.profile ?? null,
            args.browserOnly === true,
          ]),
        )
        .digest("hex");
      const existing = this.records.find((r) => r.requestId === requestId);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new Error(
            "Request ID already belongs to different instructions",
          );
        return this.status(existing);
      }
      if (this.records.length >= 10000)
        throw new Error("External task history is full");
      const record: RecordEntry = {
        id: randomUUID(),
        requestId,
        fingerprint,
        state: "starting",
      };
      this.records.push(record);
      this.save();
      try {
        const session = await this.rpc("session.new", {
          ...(args.root ? { root: args.root } : {}),
          ...(args.profile ? { profile: args.profile } : {}),
          title: input.slice(0, 100),
        });
        const stored = await this.rpc("session.get", {
          id: session.id,
          profile: args.profile,
        });
        record.session = session.id;
        record.profile = stored.profile;
        this.save();
        await this.rpc("chat.send", {
          id: session.id,
          profile: record.profile,
          input,
          maxTokens: args.browserOnly ? 50000 : 150000,
          maxRuntimeMs: 900000,
          ...(args.browserOnly ? { toolAllowlist: ["hades_browser"] } : {}),
        });
        record.state = "started";
        this.save();
      } catch (error) {
        record.state = "failed";
        record.error =
          error instanceof Error ? error.message : "Could not start task";
        this.save();
      }
      return this.status(record);
    }
    const record = this.records.find((r) => r.id === identifier(args.id));
    if (!record || !record.session)
      throw new Error("External conversation not found");
    if (operation === "cancel") {
      await this.rpc("chat.stop", { id: record.session });
      const session = await this.rpc("session.get", {
        id: record.session,
        profile: record.profile,
      });
      const children = [
        ...(session.delegatedWork ?? []).map((id: string) => ({
          id,
          method: "work.stop",
        })),
        ...(session.helmRuns ?? []).map((id: string) => ({
          id,
          method: "helm.cancel",
        })),
        ...(session.orcaIntents ?? []).map((item: { id: string }) => ({
          id: item.id,
          method: "helm.orca.stop",
        })),
      ];
      const results = await Promise.allSettled(
        children.map((child) =>
          this.rpc(child.method, {
            id: child.id,
            profile: record.profile,
            root: session.root,
          }),
        ),
      );
      return {
        conversation: await this.status(record),
        cancellation: results.map((result, index) => ({
          id: children[index].id,
          status: result.status,
          ...(result.status === "rejected"
            ? { error: String(result.reason) }
            : {}),
        })),
      };
    }
    if (operation === "continue") {
      const requestId = identifier(args.requestId),
        input = message(args.input);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([record.id, input]))
        .digest("hex");
      const prior = this.records.find((r) => r.requestId === requestId);
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new Error(
            "Request ID already belongs to different instructions",
          );
        return this.status(prior);
      }
      if (this.records.length >= 10000)
        throw new Error("External task history is full");
      if (this.pending.has(record.session))
        throw new Error(
          "A message is already being admitted; inspect status first",
        );
      this.pending.add(record.session);
      const receipt: RecordEntry = {
        id: randomUUID(),
        requestId,
        fingerprint,
        session: record.session,
        profile: record.profile,
        state: "starting",
      };
      this.records.push(receipt);
      this.save();
      try {
        await this.rpc("chat.send", {
          id: record.session,
          profile: record.profile,
          input,
          maxTokens: record.browserOnly ? 50000 : 150000,
          maxRuntimeMs: 900000,
        });
        receipt.state = "started";
      } catch (error) {
        receipt.state = "failed";
        receipt.error =
          error instanceof Error ? error.message : "Could not continue";
      } finally {
        this.pending.delete(record.session);
        this.save();
      }
      return this.status(receipt);
    }
    return this.status(record);
  }
  private async children(
    ids: string[],
    method: string,
    profile?: string,
    root?: string,
  ) {
    return Promise.all(
      ids.map(async (id) => {
        try {
          return await this.rpc(method, {
            id,
            profile,
            ...(root ? { root } : {}),
          });
        } catch (error) {
          return {
            id,
            status: "unavailable",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }
  private async status(record: RecordEntry) {
    if (!record.session)
      return { id: record.id, state: record.state, error: record.error };
    const session = await this.rpc("session.get", {
      id: record.session,
      profile: record.profile,
    });
    return {
      id: record.id,
      sessionId: record.session,
      admission: record.state,
      error: record.error,
      root: session.root,
      progress: session.progress,
      goal: session.conversationGoal,
      messages: (session.messages ?? []).slice(-12).map((m: any) => ({
        role: m.role,
        content: String(m.content ?? "").slice(-16000),
        at: m.at,
      })),
      work: await this.children(
        session.delegatedWork ?? [],
        "work.get",
        record.profile,
      ),
      helm: await this.children(
        session.helmRuns ?? [],
        "helm.get",
        record.profile,
      ),
      orca: await this.children(
        (session.orcaIntents ?? []).map((intent: { id: string }) => intent.id),
        "helm.orca.get",
        record.profile,
        session.root,
      ),
      instruction:
        "Inspect progress and result evidence. Admission is not completion. Any pending approval must be resolved in Hades.",
    };
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value))
    throw new Error("Provide a valid identifier");
  return value;
}
function message(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 16000 ||
    value.includes("\0")
  )
    throw new Error("Provide instructions up to 16,000 characters");
  return value;
}
