import type { AgentEndpoint } from "./bus";
import type { A2AMessage } from "./types";

export type TopicHandler = (msg: A2AMessage) => void;

/** Subscribe to every topic with this key. */
export const ALL_TOPICS = "*";

/**
 * Topic pub/sub over an {@link AgentEndpoint}. The transport already delivers a
 * team broadcast to every member; this layer lets each agent *subscribe to the
 * topics it cares about* so a broadcast on `"build:done"` only wakes the
 * subscribers of that topic. `publish` is a team-scoped broadcast carrying the
 * topic; `subscribe(ALL_TOPICS, …)` taps the firehose (coordination, logging).
 */
export class PubSub {
  private topics = new Map<string, Set<TopicHandler>>();
  private readonly off: () => void;

  constructor(private readonly endpoint: AgentEndpoint) {
    this.off = endpoint.on((m) => this.route(m));
  }

  subscribe(topic: string, handler: TopicHandler): () => void {
    let set = this.topics.get(topic);
    if (!set) {
      set = new Set();
      this.topics.set(topic, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.topics.delete(topic);
    };
  }

  /** Publish an event on a topic to the team (or globally if no team). */
  publish<T>(topic: string, payload: T, opts: { team?: string } = {}): void | Promise<void> {
    return this.endpoint.broadcast(payload, { team: opts.team, topic });
  }

  /** Topics with at least one live subscriber. */
  topicsSubscribed(): string[] {
    return [...this.topics.keys()].filter((t) => t !== ALL_TOPICS);
  }

  private route(msg: A2AMessage): void {
    if (msg.topic) {
      for (const h of this.topics.get(msg.topic) ?? []) h(msg);
    }
    for (const h of this.topics.get(ALL_TOPICS) ?? []) h(msg);
  }

  close(): void {
    this.off();
    this.topics.clear();
  }
}
