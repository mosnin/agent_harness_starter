import type { DesktopQueuedRequest, DesktopRequestLane, DesktopRequestQueue } from "./desktop-request-queue";

// Keep in sync with the native bridge's reserved admission policy. These lanes
// provide responsiveness; the Workbench still checks every request's authority.
export const DESKTOP_CONTROL_METHODS = [
  "approval.reply", "chat.stop", "room.stop", "job.cancel", "computer.stop",
  "local.cancel", "codex.cancel", "slack.disconnect", "browser.disconnect",
  "team.disconnect", "terminal.close", "helm.cancel", "helm.source.cancel",
  "helm.code.close", "helm.orca.stop", "work.stop", "spatial.cancel",
  "voice.stop",
  "ecosystem.disconnect",
] as const;
const inspections = new Set([
  "models.list", "slack.status", "team.status", "team.messages", "team.read",
  "codex.status", "codex.login", "voice.transcribe", "local.list",
  "computer.configure", "terminal.write", "terminal.resize", "key.set",
  "work.list", "work.get", "work.audit.head", "work.audit.read", "work.audit.export",
  "work.source.status", "work.orca.acceptance", "work.orca.replacement",
  "helm.code.status", "helm.list", "helm.get", "helm.orca.info", "helm.orca.list",
  "helm.orca.get", "helm.orca.read", "helm.orca.refresh", "helm.orca.recover",
  "spatial.status", "browser.status", "session.get",
  "ecosystem.list", "ecosystem.data", "ecosystem.record", "ecosystem.sync", "ecosystem.permissions",
  "native.ecosystem.unlock", "native.ecosystem.callback", "companyos.status", "companyos.check",
]);
export function desktopRequestLane(method: string, args?: unknown): DesktopRequestLane {
  if ((DESKTOP_CONTROL_METHODS as readonly string[]).includes(method)) return "control";
  const operation = args && typeof args === "object" ? (args as Record<string, unknown>).operation : undefined;
  if (method === "spatial.workflow" && (operation === "stop" || operation === "cancel")) return "control";
  return inspections.has(method) ? "inspection" : "serial";
}

/** Exact raw scope only. Aliases/default profiles are never guessed across
 * waiting commands; the host subsequently validates and inspects real scope. */
export function queuedOrcaStartMatchesStop(start: DesktopQueuedRequest, stop: DesktopQueuedRequest): boolean {
  if (start.method !== "helm.orca.start" || stop.method !== "helm.orca.stop") return false;
  const a = start.args as Record<string, unknown> | undefined, b = stop.args as Record<string, unknown> | undefined;
  return !!a && !!b && typeof b.id === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(b.id)
    && a.requestId === b.id && typeof a.root === "string" && a.root === b.root && a.profile === b.profile;
}

function queuedStartMatchesStop(start: DesktopQueuedRequest, stop: DesktopQueuedRequest): boolean {
  if (queuedOrcaStartMatchesStop(start, stop)) return true;
  if (stop.method === "voice.stop" && start.method === "voice.speak") return true;
  const a = start.args as Record<string, unknown> | undefined, b = stop.args as Record<string, unknown> | undefined;
  if (!a || !b || a.profile !== b.profile) return false;
  if (stop.method === 'ecosystem.disconnect' && start.method === 'ecosystem.connect') return typeof b.pluginId === 'string' && a.pluginId === b.pluginId;
  if (stop.method === "work.stop" && ["work.run", "work.resume", "work.orca.import", "work.orca.accept", "work.orca.replace"].includes(start.method)) return typeof b.id === "string" && a.id === b.id;
  if (stop.method === "work.stop" && ["helm.verify","helm.integration.prepare","helm.integration.apply","helm.source.start"].includes(start.method)) return typeof b.id === "string" && a.workGoalId === b.id;
  if (stop.method === "helm.code.close" && start.method === "helm.code.open") return typeof b.root === "string" && a.root === b.root;
  if (stop.method === "spatial.cancel" && start.method === "spatial.capture") return typeof b.sessionId === "string" && a.sessionId === b.sessionId;
  if (stop.method === "spatial.workflow" && start.method === "spatial.workflow" && (b.operation === "stop" || b.operation === "cancel") && (a.operation === "start" || a.operation === "replay")) return typeof b.sessionId === "string" && a.sessionId === b.sessionId && typeof b.tabId === "string" && a.tabId === b.tabId;
  return false;
}

/** The entry point and deterministic integration tests use this same route. */
export function scheduleDesktopRequest<R extends DesktopQueuedRequest>(queue: DesktopRequestQueue<R>, request: R, host: {
  handle(request: R, context: { cancelledOrcaStartBeforeAdmission: boolean }): Promise<void>;
  rejected(request: R, error: unknown): void;
}): Promise<void> {
  return queue.submit(request, desktopRequestLane(request.method, request.args), async admitted => {
    const cancelled = queue.cancelQueued(start => queuedStartMatchesStop(start, admitted));
    await host.handle(admitted, { cancelledOrcaStartBeforeAdmission: admitted.method === "helm.orca.stop" && cancelled.cancelledBeforeAdmission > 0 });
  }).catch(error => { try { host.rejected(request, error); } catch { /* detached output cannot poison the queue */ } });
}
