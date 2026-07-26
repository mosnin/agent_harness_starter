import { InMemoryMemoryStore } from "../memory/store";
import { InMemorySessionStore } from "../memory/session-store";
import { ConversationalAgent } from "../repl/agent";
import type { ConversationBrain } from "../repl/agent";
import type { ReplIO } from "../repl/core";

/**
 * A runnable, dependency-free demonstration of the Hades closed learning loop.
 * It wires a memory store + session store + a canned "brain" into a
 * {@link ConversationalAgent}, feeds a scripted conversation (including a
 * `/remember`), and returns the full transcript. Real deployments swap the
 * canned brain for the swarm/LLM; everything else is identical.
 *
 * Run it from a script with `demoLearningLoop().forEach(l => console.log(l))`,
 * or import it in a test to see the loop in action.
 */
export async function demoLearningLoop(): Promise<string[]> {
  const memory = new InMemoryMemoryStore();
  const sessions = new InMemorySessionStore();

  // A brain that greets, then references whatever memories were retrieved —
  // demonstrating that a fact remembered on one turn resurfaces on the next.
  const brain: ConversationBrain = async (ctx, stream) => {
    const recalled = ctx.memories.map((m) => m.fact);
    const reply = recalled.length
      ? `Given what I know (${recalled.join("; ")}), here's my take on "${ctx.input}".`
      : `On it: "${ctx.input}".`;
    stream(reply);
    return reply;
  };

  const transcript: string[] = [];
  const io: ReplIO = {
    write: (c) => transcript.push(`hades: ${c}`),
    writeLine: (l) => (l ? transcript.push(l) : undefined),
  };

  const agent = new ConversationalAgent({ brain, memory, sessions });
  const repl = agent.repl(io);

  const script = [
    "/remember I deploy on Fridays and prefer TypeScript",
    "help me plan a TypeScript deploy",
  ];
  for (const line of script) {
    transcript.push(`you: ${line}`);
    await repl.feedLine(line);
  }

  return transcript;
}
