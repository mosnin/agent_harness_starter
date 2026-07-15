import { randomUUID } from "node:crypto";
import type {
  ContainerHandle,
  ContainerProvider,
  IsolationKind,
  SpawnSpec,
} from "../types";

/**
 * Zero-isolation provider that runs the worker loop **in the current process**
 * via a supplied factory. It exists for two reasons:
 *
 *  1. Unit tests — deterministic, no OS spawning, no Docker.
 *  2. `--inline` mode — run a whole swarm single-process for quick local trials
 *     before committing to container spawning.
 *
 * Because there is no real isolation here, the verification gate and guardrails
 * carry the full weight of anti-rogue enforcement. Never use inline mode for
 * untrusted goals in production — use the Docker provider.
 */
export class InlineProvider implements ContainerProvider {
  readonly kind: IsolationKind = "inline";
  private running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private logs_ = new Map<string, string[]>();

  constructor(
    /** Starts the worker loop; resolves when the worker exits. */
    private readonly runWorker: (
      spec: SpawnSpec,
      signal: AbortSignal,
      log: (line: string) => void
    ) => Promise<void>
  ) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async spawn(spec: SpawnSpec): Promise<ContainerHandle> {
    const abort = new AbortController();
    const buf: string[] = [];
    this.logs_.set(spec.workerId, buf);
    const log = (line: string) => {
      buf.push(line);
      if (buf.length > 500) buf.shift();
    };
    const done = this.runWorker(spec, abort.signal, log).catch((e) => {
      log(`worker crashed: ${e instanceof Error ? e.message : String(e)}`);
    });
    this.running.set(spec.workerId, { abort, done });
    return {
      workerId: spec.workerId,
      nativeId: randomUUID(),
      kind: this.kind,
      startedAt: Date.now(),
    };
  }

  async stop(handle: ContainerHandle, graceMs = 1000): Promise<void> {
    const r = this.running.get(handle.workerId);
    if (!r) return;
    r.abort.abort();
    // A wedged executor may never return even after abort; don't let a hung
    // worker block shutdown. Race the clean exit against a grace timeout.
    await Promise.race([r.done, new Promise<void>((res) => setTimeout(res, graceMs))]);
    this.running.delete(handle.workerId);
  }

  async isAlive(handle: ContainerHandle): Promise<boolean> {
    return this.running.has(handle.workerId);
  }

  async logs(handle: ContainerHandle, tailLines = 100): Promise<string> {
    return (this.logs_.get(handle.workerId) ?? []).slice(-tailLines).join("\n");
  }
}
