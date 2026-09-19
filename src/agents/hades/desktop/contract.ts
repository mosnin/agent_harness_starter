/**
 * Wire format between the Hades Tauri window and the Node sidecar.
 *
 * Renderer → sidecar: newline-delimited {@link DesktopCommand} JSON.
 * Sidecar → renderer: newline-delimited {@link DesktopEvent} JSON.
 *
 * Tauri names (must match src-tauri):
 *   invoke("hades_command", { command })
 *   listen("hades_event", handler)
 *
 * This is the Jev-aware subset the harness owns. The larger swarm/fleet
 * contract on other Hades branches can wrap these kinds without renaming them.
 */

export const DESKTOP_COMMAND_KINDS = [
  "runtime.start",
  "chat.prefetch",
  "chat.send",
  "voice.turn",
  "desktop.act",
  "approval.respond",
] as const;

export const DESKTOP_EVENT_KINDS = [
  "runtime.ready",
  "message.delta",
  "message.done",
  "jev.decision",
  "jev.prefetch",
  "jev.timing",
  "approval.required",
  "desktop.result",
  "error",
  "run.done",
] as const;

export type DesktopCommandKind = (typeof DESKTOP_COMMAND_KINDS)[number];
export type DesktopEventKind = (typeof DESKTOP_EVENT_KINDS)[number];

export type DesktopCommand =
  | { type: "runtime.start" }
  | { type: "chat.prefetch"; text: string }
  | { type: "chat.send"; text: string; threadId?: string }
  | { type: "voice.turn"; audioBase64: string; mimeType?: string }
  | { type: "desktop.act"; action: string; args?: Record<string, unknown>; userRequest?: string }
  | { type: "approval.respond"; approvalId: string; approved: boolean };

export type DesktopEvent =
  | { type: "runtime.ready"; inference: DesktopInference }
  | { type: "message.delta"; delta: string }
  | { type: "message.done"; content: string }
  | {
      type: "jev.decision";
      node: string;
      decision: string;
      reason: string;
      action: "auto" | "review" | "block" | "fallback";
      confidence?: number;
      latencyMs?: number;
      cached?: boolean;
    }
  | {
      type: "jev.prefetch";
      asks: number;
      latencyMs: number;
      cached: boolean;
      skipGeneration: boolean;
      route: string;
    }
  | { type: "jev.timing"; phase: "warmup" | "prefetch" | "preflight"; latencyMs: number; ok: boolean }
  | {
      type: "approval.required";
      runId: string;
      approvalId: string;
      toolName: string;
      input: unknown;
      description: string;
    }
  | { type: "desktop.result"; action: string; ok: boolean; output?: unknown; error?: string }
  | { type: "error"; error: string; code?: string }
  | { type: "run.done"; finalOutput: string };

export interface DesktopInference {
  kind: "hades" | "mock";
  detail: string;
  jev: boolean;
  qwen: boolean;
  voice: boolean;
}

export function detectDesktopInference(
  env: Record<string, string | undefined> = process.env
): DesktopInference {
  const jev = Boolean(env.TYPESAFE_API_KEY || env.JEV_API_KEY);
  const qwen = Boolean(env.OPENROUTER_API_KEY);
  const voice = Boolean(env.OPENAI_API_KEY);
  if (jev && qwen) {
    return {
      kind: "hades",
      detail: `jev+qwen${voice ? "+voice" : ""}`,
      jev,
      qwen,
      voice,
    };
  }
  return {
    kind: "mock",
    detail: "no TYPESAFE_API_KEY + OPENROUTER_API_KEY — sidecar will fail-close writes",
    jev,
    qwen,
    voice,
  };
}

export function isDesktopCommand(value: unknown): value is DesktopCommand {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type: unknown }).type;
  return typeof type === "string" && (DESKTOP_COMMAND_KINDS as readonly string[]).includes(type);
}

export function isDesktopEvent(value: unknown): value is DesktopEvent {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = (value as { type: unknown }).type;
  return typeof type === "string" && (DESKTOP_EVENT_KINDS as readonly string[]).includes(type);
}

export function encodeDesktopMessage(value: DesktopCommand | DesktopEvent): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodeDesktopCommand(line: string): DesktopCommand {
  const parsed: unknown = JSON.parse(line);
  if (!isDesktopCommand(parsed)) {
    throw new Error("Invalid desktop command");
  }
  if (
    (parsed.type === "chat.send" || parsed.type === "chat.prefetch") &&
    (!parsed.text || typeof parsed.text !== "string")
  ) {
    throw new Error(`${parsed.type} requires text`);
  }
  if (parsed.type === "desktop.act" && (!parsed.action || typeof parsed.action !== "string")) {
    throw new Error("desktop.act requires action");
  }
  return parsed;
}

export function decodeDesktopEvent(line: string): DesktopEvent {
  const parsed: unknown = JSON.parse(line);
  if (!isDesktopEvent(parsed)) {
    throw new Error("Invalid desktop event");
  }
  return parsed;
}
