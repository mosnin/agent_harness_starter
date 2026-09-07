import type { ChatMessage } from "../models/client";
import type { ContextArchive } from "../memory/context-archive";

/** Replace only settled tool pairs, after durable archival. User requirements,
 * system instructions, errors and the latest three tool exchanges stay exact.
 * References remain data at the same role; they never acquire system authority.
 */
export class ArchivedContext {
  private readonly replacements = new Map<number, ChatMessage>();
  private readonly references = new Set<string>();
  constructor(private readonly archive: ContextArchive) {}
  view(messages: ChatMessage[], settled: Array<{ callIndex: number; resultIndex: number; tool: string; ok: boolean }>): ChatMessage[] {
    for (const pair of settled.slice(0, -3)) {
      if (!pair.ok || pair.tool === "context_read" || this.replacements.has(pair.callIndex)) continue;
      const call = messages[pair.callIndex], result = messages[pair.resultIndex];
      if (call.content.length + result.content.length < 2048) continue;
      // Neither placeholder becomes visible until both writes have completed.
      const callRef = this.archive.put(call), resultRef = this.archive.put(result);
      this.references.add(callRef); this.references.add(resultRef);
      this.replacements.set(pair.callIndex, { role: call.role, content:
        `[Settled ${pair.tool} request. Arguments archived as ${callRef}. Use context_read to inspect them; do not repeat an action just to recall it.]` });
      this.replacements.set(pair.resultIndex, { role: result.role, content:
        `TOOL_RESULT: [Archived observation ${resultRef}; tool returned ok=true, which does not independently verify task success. Use context_read for exact content.]` });
    }
    return messages.map((message, index) => this.replacements.get(index) ?? { ...message });
  }
  read(input: string) {
    const args = JSON.parse(input);
    if (!args || !this.references.has(args.reference)) throw new Error("Unknown context reference for this turn");
    return JSON.stringify(this.archive.read(args.reference, args.offset ?? 0, args.limit ?? 6000));
  }
}

/** A working view, never a mutation of the audit transcript. Only byte-identical
 * settled tool observations are elided; errors, calls and user requirements stay.
 */
export function contextView(transcript: ChatMessage[], observations: ReadonlySet<number> = new Set()): ChatMessage[] {
  const latest = new Map<string, number>();
  transcript.forEach((message, index) => {
    if (observations.has(index) && message.role === "user" && message.content.startsWith("TOOL_RESULT:") && message.content.length > 256 && !message.images?.length)
      latest.set(message.content, index);
  });
  const latestImage = transcript.findLastIndex((message,index) => observations.has(index) && !!message.images?.length);
  return transcript.map((message, index) => {
    if (observations.has(index) && message.images?.length && index < latestImage) {
      const { images, ...text } = message;
      return { ...text, content: text.content + "\n[Earlier screenshot omitted from working context; observe again for current screen state.]" };
    }
    const kept = observations.has(index) ? latest.get(message.content) : undefined;
    return kept !== undefined && kept !== index
      ? { ...message, content: `TOOL_RESULT: [Repeated observation; identical full content is retained at message ${kept + 1}.]` }
      : { ...message };
  });
}

/** Conservative estimate, not a tokenizer. Retain measured provider usage even
 * after archival, then charge full UTF-8 bytes for new/replaced messages. Do not
 * subtract guessed savings for removed content. The next response recalibrates.
 * Images use a conservative planning allowance of 16,384 tokens per image,
 * not base64 character count or a provider tokenizer. Actual usage recalibrates it.
 * Resetting the entire view to bytes after every archive would falsely report
 * overflow even when the measured serving context is mostly empty.
 */
export class ContextBudget {
  private measured?: { messages: string[]; tokens: number };
  estimate(messages: ChatMessage[]): number {
    const keys = messages.map(message => JSON.stringify(message));
    const previous = this.measured;
    const changed = previous ? messages.filter((_message, index) => keys[index] !== previous.messages[index]) : messages;
    return (previous?.tokens ?? 0) + changed.reduce((sum, message) =>
      sum + new TextEncoder().encode(message.content).length + 32 +
      (message.images?.length ?? 0) * 16_384, 0);
  }
  observe(messages: ChatMessage[], inputTokens: number) {
    if (Number.isSafeInteger(inputTokens) && inputTokens > 0)
      this.measured = { messages: messages.map(message => JSON.stringify(message)), tokens: inputTokens };
  }
}
