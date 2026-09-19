/**
 * DesktopHost — in-process brain the Tauri sidecar talks to.
 *
 * Jev decides. Qwen generates. OpenAI only speaks. The native window only
 * sends {@link DesktopCommand}s and renders {@link DesktopEvent}s.
 */

import { createHadesHarness, type HadesConfig, type HadesHarness } from "../index";
import {
  assessDesktopAction,
  isDesktopAction,
  shouldExecuteDesktop,
} from "../../jev/desktop";
import { createJevAsker, warmupJev } from "../../jev/client";
import { runPreflight } from "../../jev/preflight";
import type { JevAsker } from "../../jev/types";
import type { AgentEvent } from "../../types";
import { createCapRunner, type CapRunner } from "./cap";
import {
  detectDesktopInference,
  desktopVoiceOversize,
  MAX_DESKTOP_VOICE_BYTES,
  type DesktopCommand,
  type DesktopEvent,
} from "./contract";
import { createRedactStream, redactSecrets, redactValue, type RedactStream } from "../../jev/redact";
import { appendHarnessTurn, messagesForHarness, type HarnessMessage } from "../../lib/thread-history";

export interface DesktopHostOptions {
  /** Existing harness (tests). Otherwise built from {@link agent}. */
  harness?: HadesHarness;
  agent?: Partial<HadesConfig>;
  asker?: JevAsker;
  cap?: CapRunner;
  onEvent?: (event: DesktopEvent) => void;
  skipProviderSetup?: boolean;
}

export interface DesktopHost {
  handle(command: DesktopCommand): Promise<void>;
}

export function createDesktopHost(options: DesktopHostOptions = {}): DesktopHost {
  const asker = options.asker ?? createJevAsker();
  const harness =
    options.harness ??
    createHadesHarness({
      name: "Hades",
      instructions:
        "You are Hades, the desktop agent. Jev already screened this turn. Do the work. Prefer hades_* tools for capture and edit.",
      tools: options.agent?.tools ?? [],
      skipProviderSetup: options.skipProviderSetup ?? options.agent?.skipProviderSetup ?? true,
      registerMcp: false,
      jev: { asker, ...(options.agent?.jev ?? {}) },
      ...options.agent,
    });
  const cap = options.cap ?? createCapRunner();
  const threads = new Map<string, HarnessMessage[]>();
  const emit = (event: DesktopEvent) => {
    options.onEvent?.(event);
  };

  return {
    async handle(command) {
      switch (command.type) {
        case "runtime.start": {
          emit({ type: "runtime.ready", inference: detectDesktopInference() });
          const warm = await warmupJev(asker);
          emit({ type: "jev.timing", phase: "warmup", latencyMs: warm.latencyMs, ok: warm.ok });
          return;
        }
        case "chat.prefetch":
          await runPrefetch(command.text, asker, emit);
          return;
        case "chat.send":
          await runChat(harness, command.text, command.threadId, threads, emit);
          return;
        case "voice.turn":
          await runVoice(harness, command.audioBase64, command.threadId, threads, emit);
          return;
        case "desktop.act":
          await runDesktopAct(command, asker, cap, emit);
          return;
        case "approval.respond":
          emit({
            type: "error",
            error: "approval.respond is handled by the approvals plugin in-process",
            code: "approval-external",
          });
          return;
      }
    },
  };
}

async function runPrefetch(
  text: string,
  asker: JevAsker,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  const started = Date.now();
  const pre = await runPreflight({
    message: text,
    asker,
    requireScreen: true,
  });
  emit({
    type: "jev.prefetch",
    asks: pre.asks,
    latencyMs: pre.latencyMs ?? Date.now() - started,
    cached: Boolean(pre.cached),
    skipGeneration: pre.skipGeneration,
    route: pre.routed.tier ?? pre.routed.value,
  });
}

async function runChat(
  harness: HadesHarness,
  text: string,
  threadId: string | undefined,
  threads: Map<string, HarnessMessage[]>,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  const id = threadId?.trim() || "default";
  const prior = threads.get(id) ?? [];
  const messages = appendHarnessTurn(prior, { role: "user", content: text });
  let finalOutput = "";
  const stream = createRedactStream();
  for await (const event of harness.stream({
    messages,
    context: { channel: "desktop", threadId: id },
  })) {
    forwardAgentEvent(event, emit, stream);
    if (event.type === "message_done") finalOutput = event.content;
    if (event.type === "done") finalOutput = event.finalOutput;
  }
  const spoken = redactSecrets(finalOutput).text;
  threads.set(id, messagesForHarness([...messages, { role: "assistant", content: spoken }]));
  emit({ type: "run.done", finalOutput: spoken });
}

async function runVoice(
  harness: HadesHarness,
  audioBase64: string,
  threadId: string | undefined,
  threads: Map<string, HarnessMessage[]>,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  const id = threadId?.trim() || "default";
  const prior = threads.get(id) ?? [];
  if (desktopVoiceOversize(audioBase64)) {
    emit({ type: "error", error: "voice.turn audio exceeds size cap", code: "voice-oversize" });
    return;
  }
  const audio = Buffer.from(audioBase64, "base64");
  if (audio.byteLength > MAX_DESKTOP_VOICE_BYTES) {
    emit({ type: "error", error: "voice.turn audio exceeds size cap", code: "voice-oversize" });
    return;
  }
  const result = await harness.voiceTurn(audio, {
    messages: prior,
    context: { channel: "desktop", threadId: id },
  });
  const spoken = redactSecrets(result.finalOutput).text;
  const transcript = redactSecrets(result.transcript).text;
  threads.set(
    id,
    messagesForHarness([
      ...prior,
      { role: "user", content: transcript },
      { role: "assistant", content: spoken },
    ])
  );
  emit({ type: "message.done", content: spoken });
  emit({ type: "run.done", finalOutput: spoken });
}

async function runDesktopAct(
  command: Extract<DesktopCommand, { type: "desktop.act" }>,
  asker: JevAsker,
  cap: CapRunner,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  if (!isDesktopAction(command.action)) {
    emit({
      type: "desktop.result",
      action: command.action,
      ok: false,
      error: "unknown-desktop-action",
    });
    return;
  }
  const decision = await assessDesktopAction({
    action: command.action,
    args: command.args,
    userRequest: command.userRequest,
    asker,
  });
  emit({
    type: "jev.decision",
    node: decision.node,
    decision: String(decision.value),
    reason: decision.reason,
    action: decision.action,
    confidence: decision.confidence,
    latencyMs: decision.latencyMs,
    cached: decision.cached,
  });
  if (!shouldExecuteDesktop(decision)) {
    emit({
      type: "desktop.result",
      action: command.action,
      ok: false,
      error: decision.reason,
    });
    return;
  }
  try {
    const output = redactValue(await cap.run(command.action, command.args ?? {}));
    emit({ type: "desktop.result", action: command.action, ok: true, output });
  } catch (error) {
    emit({
      type: "desktop.result",
      action: command.action,
      ok: false,
      error: redactSecrets(error instanceof Error ? error.message : String(error)).text,
    });
  }
}

function forwardAgentEvent(
  event: AgentEvent,
  emit: (event: DesktopEvent) => void,
  stream?: RedactStream
): void {
  if (event.type === "message_delta") {
    emit({ type: "message.delta", delta: stream ? stream.push(event.delta) : redactSecrets(event.delta).text });
    return;
  }
  if (event.type === "message_done") {
    stream?.flush();
    emit({ type: "message.done", content: redactSecrets(event.content).text });
    return;
  }
  if (event.type === "jev_decision") {
    emit({
      type: "jev.decision",
      node: event.node,
      decision: event.decision,
      reason: event.reason,
      action: event.action,
      confidence: event.confidence,
      latencyMs: event.latencyMs,
      cached: event.cached,
    });
    return;
  }
  if (event.type === "approval_required") {
    emit({
      type: "approval.required",
      runId: event.runId,
      approvalId: event.approvalId,
      toolName: event.toolName,
      input: redactValue(event.input),
      description: redactSecrets(event.description).text,
    });
    return;
  }
  if (event.type === "error") {
    emit({ type: "error", error: redactSecrets(event.error).text, code: event.code });
  }
}
