/**
 * Load a persisted or in-memory thread into the harness message shape.
 *
 * /api/hades and desktop chat.send used to pass only the latest user line.
 * Jev then never saw `previous_assistant_reply`, compaction had nothing to
 * prune, and Qwen re-solved every turn. Code loads history; Jev decides
 * what to keep.
 */

import { redactSecrets } from "../jev/redact";

export const MAX_HARNESS_MESSAGES = 40;
export const MAX_MESSAGE_CHARS = 8000;

export interface HarnessMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

const ROLES = new Set(["user", "assistant", "system"]);

export function isThreadOwner<T extends { userId: string }>(
  thread: T | null | undefined,
  userId: string
): thread is T {
  return Boolean(thread && thread.userId === userId);
}

export function messagesForHarness(
  rows: Array<{ role: string; content: string }>,
  max = MAX_HARNESS_MESSAGES
): HarnessMessage[] {
  return rows
    .filter((row) => ROLES.has(row.role))
    .map((row) => ({
      role: row.role as HarnessMessage["role"],
      content: redactSecrets(row.content).text.slice(0, MAX_MESSAGE_CHARS),
    }))
    .slice(-max);
}

export function appendHarnessTurn(
  prior: HarnessMessage[],
  turn: HarnessMessage
): HarnessMessage[] {
  return messagesForHarness([...prior, turn]);
}
