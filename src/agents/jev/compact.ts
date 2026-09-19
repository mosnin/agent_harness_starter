/**
 * Apply Jev compaction decisions to the thread we inject into Qwen.
 *
 * pi-fast-jev-compaction: never rewrite user/assistant prose; prune stale
 * tool blobs. We do not call an LLM to summarize — that would erase the
 * speed win. Code drops or heads tool transcripts; Jev only picks the tier.
 */

import { redactSecrets } from "./redact";

export type CompactStrategy = "keep" | "summarize" | "aggressive";

export interface ThreadMessage {
  role: string;
  content: string;
}

const TOOL_BLOB = /exitCode|stdout|stderr|"results"\s*:|tool_result/i;

export function isToolBlob(content: string): boolean {
  return content.length > 800 || TOOL_BLOB.test(content) || /^[\[{]/.test(content.trim());
}

export function parseCompactStrategy(value: unknown): CompactStrategy {
  if (value === "summarize" || value === "aggressive" || value === "keep") return value;
  return "keep";
}

function scrub(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.map((msg) => ({ ...msg, content: redactSecrets(msg.content).text }));
}

export function applyCompaction(messages: ThreadMessage[], strategy: CompactStrategy): ThreadMessage[] {
  if (strategy === "keep" || messages.length <= 3) return scrub(messages);

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const keepTail = strategy === "aggressive" ? 2 : 4;
  const tailStart = Math.max(1, messages.length - keepTail);
  const middle = messages.slice(1, tailStart);
  const tail = messages.slice(tailStart, -1);

  const prunedMiddle =
    strategy === "aggressive"
      ? middle
          .filter((msg) => msg.role === "user" || !isToolBlob(msg.content))
          .map((msg) => ({ ...msg, content: head(msg.content, 240) }))
      : middle.map((msg) =>
          isToolBlob(msg.content) ? { ...msg, content: head(msg.content, 240) } : msg
        );

  const note: ThreadMessage = {
    role: "system",
    content: `[jev compacted ${middle.length} middle turn(s) · ${strategy}]`,
  };

  return scrub([first, note, ...prunedMiddle, ...tail, last]);
}

export function formatCompactThread(messages: ThreadMessage[], maxChars = 3000): string {
  const body = messages
    .map((msg) => `${msg.role}: ${redactSecrets(msg.content).text}`)
    .join("\n")
    .slice(0, maxChars);
  return body;
}

function head(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return `${text.slice(0, chars)}…`;
}
