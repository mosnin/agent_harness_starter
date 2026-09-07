type Event = Record<string, any>;
export interface ToolActivityCard {
  tool: string; input?: string; output?: string;
  status: "Running" | "Completed" | "Failed" | "Interrupted";
}
const stable = (value: any): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
function inputKey(input: unknown) {
  if (typeof input !== "string") return "";
  try { return stable(JSON.parse(input)); } catch { return input; }
}

/** Derive one review card per execution without changing the source journal.
 * Turn boundaries prevent a later call from completing an earlier interruption. */
export function toolActivityCards(events: readonly Event[], running: boolean): ToolActivityCard[] {
  const cards: ToolActivityCard[] = [];
  let pending: Array<{ index: number; key: string; callId?: string }> = [];
  const interrupt = () => { for (const item of pending) cards[item.index].status = "Interrupted"; pending = []; };
  for (const event of events) {
    if (["desktop.started", "desktop.done"].includes(event.kind)) { interrupt(); continue; }
    if ((event.kind && event.kind !== "desktop.tool") || !event.tool) continue;
    const key = inputKey(event.input), callId = event.callId ?? event.toolCallId;
    if (event.status === "running") {
      pending.push({ index: cards.length, key, callId });
      cards.push({ tool: event.tool, input: event.input, status: "Running" });
      continue;
    }
    const candidates = pending.filter(item => cards[item.index].tool === event.tool);
    const match = callId !== undefined ? candidates.find(item => item.callId === callId)
      : candidates.find(item => item.key === key) ?? (candidates.length === 1 && (!key || !candidates[0].key) ? candidates[0] : undefined);
    const status = ["interrupted", "cancelled"].includes(event.status) ? "Interrupted"
      : event.ok === false || ["error", "failed"].includes(event.status) ? "Failed"
      : ["done", "completed"].includes(event.status) ? "Completed" : "Interrupted";
    if (match) {
      const card = cards[match.index]; card.status = status; card.output = event.output;
      card.input = card.input ?? event.input;
      pending = pending.filter(item => item !== match);
    } else cards.push({ tool: event.tool, input: event.input, output: event.output, status });
  }
  if (!running) interrupt();
  return cards;
}
