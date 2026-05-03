"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentEvent } from "@/agents/types";
import { MessageList } from "./MessageList";
import { AgentStatus } from "../AgentStatus";

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{ name: string; input: unknown; output?: unknown }>;
}

interface AgentChatProps {
  /** Thread to load on mount (optional). */
  threadId?: string;
  /** Which agent to use. */
  agentName?: "research" | "code" | "orchestrated";
  /** Placeholder text for the input box. */
  placeholder?: string;
}

export function AgentChat({
  threadId: initialThreadId,
  agentName = "research",
  placeholder = "Ask me anything…",
}: AgentChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [threadId, setThreadId] = useState(initialThreadId);

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Load existing thread messages
  useEffect(() => {
    if (!threadId) return;
    fetch(`/api/agent?threadId=${threadId}`)
      .then((r) => r.json())
      .then((data: { messages?: Array<{ id: string; role: string; content: string }> }) => {
        if (data.messages) {
          setMessages(
            data.messages
              .filter((m) => m.role === "user" || m.role === "assistant")
              .map((m) => ({ id: m.id, role: m.role as "user" | "assistant", content: m.content }))
          );
        }
      })
      .catch(() => {});
  }, [threadId]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) return;

    setInput("");
    setIsRunning(true);
    setStatusText("Thinking…");

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: trimmed };
    setMessages((prev) => [...prev, userMsg]);

    const assistantId = crypto.randomUUID();
    const assistantMsg: Message = { id: assistantId, role: "assistant", content: "" };
    setMessages((prev) => [...prev, assistantMsg]);

    abortRef.current = new AbortController();

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, threadId, agentName }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`);
      }

      // Grab thread ID from response header
      const newThreadId = res.headers.get("X-Thread-Id");
      if (newThreadId && !threadId) setThreadId(newThreadId);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") break;

          try {
            const event = JSON.parse(raw) as AgentEvent & { threadId?: string; runId?: string };
            handleEvent(event, assistantId);
          } catch {
            // skip malformed event
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, content: `Error: ${(err as Error).message}` }
              : m
          )
        );
      }
    } finally {
      setIsRunning(false);
      setStatusText("");
      abortRef.current = null;
    }
  }, [input, isRunning, threadId, agentName]);

  function handleEvent(event: AgentEvent, assistantId: string) {
    switch (event.type) {
      case "message_delta":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: m.content + event.delta } : m
          )
        );
        break;

      case "message_done":
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId ? { ...m, content: event.content } : m
          )
        );
        break;

      case "tool_call":
        setStatusText(`Using tool: ${event.name}…`);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  toolCalls: [...(m.toolCalls ?? []), { name: event.name, input: event.input }],
                }
              : m
          )
        );
        break;

      case "tool_result":
        setStatusText("Thinking…");
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== assistantId) return m;
            const calls = [...(m.toolCalls ?? [])];
            const last = calls.at(-1);
            if (last) calls[calls.length - 1] = { ...last, output: event.output };
            return { ...m, toolCalls: calls };
          })
        );
        break;

      case "handoff":
        setStatusText(`Handing off to ${event.to}…`);
        break;

      case "done":
        if (event.finalOutput) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: event.finalOutput } : m
            )
          );
        }
        break;
    }
  }

  function cancelRun() {
    abortRef.current?.abort();
  }

  return (
    <div className="flex flex-col h-full max-h-screen">
      <div className="flex-1 overflow-y-auto p-4">
        <MessageList messages={messages} />
        <div ref={bottomRef} />
      </div>

      {isRunning && (
        <AgentStatus
          statusText={statusText}
          onCancel={cancelRun}
        />
      )}

      <div className="border-t p-4 flex gap-2">
        <textarea
          className="flex-1 resize-none rounded-lg border border-gray-300 p-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
          rows={3}
          placeholder={placeholder}
          value={input}
          disabled={isRunning}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void sendMessage();
            }
          }}
        />
        <button
          className="self-end px-5 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          disabled={!input.trim() || isRunning}
          onClick={() => void sendMessage()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
