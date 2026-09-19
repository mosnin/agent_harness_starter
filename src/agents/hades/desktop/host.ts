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
import { createJevAsker } from "../../jev/client";
import type { JevAsker } from "../../jev/types";
import type { AgentEvent } from "../../types";
import { createCapRunner, type CapRunner } from "./cap";
import {
  detectDesktopInference,
  type DesktopCommand,
  type DesktopEvent,
} from "./contract";

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
  const emit = (event: DesktopEvent) => {
    options.onEvent?.(event);
  };

  return {
    async handle(command) {
      switch (command.type) {
        case "runtime.start":
          emit({ type: "runtime.ready", inference: detectDesktopInference() });
          return;
        case "chat.send":
          await runChat(harness, command.text, command.threadId, emit);
          return;
        case "voice.turn":
          await runVoice(harness, command.audioBase64, emit);
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

async function runChat(
  harness: HadesHarness,
  text: string,
  threadId: string | undefined,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  let finalOutput = "";
  for await (const event of harness.stream({
    messages: [{ role: "user", content: text }],
    context: { channel: "desktop", threadId },
  })) {
    forwardAgentEvent(event, emit);
    if (event.type === "message_done") finalOutput = event.content;
    if (event.type === "done") finalOutput = event.finalOutput;
  }
  emit({ type: "run.done", finalOutput });
}

async function runVoice(
  harness: HadesHarness,
  audioBase64: string,
  emit: (event: DesktopEvent) => void
): Promise<void> {
  const audio = Buffer.from(audioBase64, "base64");
  const result = await harness.voiceTurn(audio, { context: { channel: "desktop" } });
  emit({ type: "message.done", content: result.finalOutput });
  emit({ type: "run.done", finalOutput: result.finalOutput });
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
    const output = await cap.run(command.action, command.args ?? {});
    emit({ type: "desktop.result", action: command.action, ok: true, output });
  } catch (error) {
    emit({
      type: "desktop.result",
      action: command.action,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function forwardAgentEvent(event: AgentEvent, emit: (event: DesktopEvent) => void): void {
  if (event.type === "message_delta") {
    emit({ type: "message.delta", delta: event.delta });
    return;
  }
  if (event.type === "message_done") {
    emit({ type: "message.done", content: event.content });
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
    });
    return;
  }
  if (event.type === "approval_required") {
    emit({
      type: "approval.required",
      runId: event.runId,
      approvalId: event.approvalId,
      toolName: event.toolName,
      input: event.input,
      description: event.description,
    });
    return;
  }
  if (event.type === "error") {
    emit({ type: "error", error: event.error, code: event.code });
  }
}
