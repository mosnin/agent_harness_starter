"use client";

import type { Message } from "./index";

interface ToolCallBadgeProps {
  name: string;
  input: unknown;
  output?: unknown;
}

function ToolCallBadge({ name, input, output }: ToolCallBadgeProps) {
  return (
    <details className="mt-2 text-xs border border-gray-200 rounded-md bg-gray-50">
      <summary className="px-3 py-1.5 cursor-pointer font-mono text-gray-600 hover:text-gray-900">
        🔧 {name} {output ? "✓" : "…"}
      </summary>
      <div className="px-3 pb-3 space-y-2">
        <div>
          <span className="text-gray-500 font-semibold">Input:</span>
          <pre className="mt-1 bg-white p-2 rounded border text-gray-800 overflow-x-auto">
            {JSON.stringify(input, null, 2)}
          </pre>
        </div>
        {output !== undefined && (
          <div>
            <span className="text-gray-500 font-semibold">Output:</span>
            <pre className="mt-1 bg-white p-2 rounded border text-gray-800 overflow-x-auto max-h-48">
              {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

interface MessageListProps {
  messages: Message[];
}

export function MessageList({ messages }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400 py-20">
        <p className="text-lg font-medium">Start a conversation</p>
        <p className="text-sm mt-1">Ask anything — the agent has access to web search and more.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-2xl rounded-2xl px-4 py-3 text-sm ${
              msg.role === "user"
                ? "bg-blue-600 text-white rounded-tr-sm"
                : "bg-white border border-gray-200 text-gray-900 rounded-tl-sm shadow-sm"
            }`}
          >
            {msg.role === "assistant" && !msg.content && (
              <span className="animate-pulse text-gray-400">●●●</span>
            )}
            {msg.content && (
              <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
            )}
            {msg.toolCalls?.map((tc, i) => (
              <ToolCallBadge key={i} name={tc.name} input={tc.input} output={tc.output} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
