import type { A2ATransport } from "../a2a/bus";
import type { RoleRegistry } from "./role";
import type { TeamFormer, TaskSpec } from "./former";
import { Team } from "./team";
import type { AgentSpawner } from "./team";

export type TeamState = "idle" | "forming" | "ready" | "working" | "disbanded" | "failed";

export interface TeamRunnerDeps {
  former: TeamFormer;
  spawner: AgentSpawner;
  transport: A2ATransport;
  roles: RoleRegistry;
  /** Observe state transitions (dashboard / audit). */
  onState?: (state: TeamState, team?: Team) => void;
}

/**
 * Runs a task through the full team lifecycle: **form → spawn → work → disband**,
 * with failure-aware teardown. Whatever happens in `work` — success, throw, or
 * timeout upstream — the team is always torn down in the `finally`, so a failed
 * run never leaks containers. On failure the state ends `failed` (teardown still
 * happens); on success it ends `disbanded`.
 */
export class TeamRunner {
  private _state: TeamState = "idle";
  private _lastError?: Error;

  constructor(private readonly deps: TeamRunnerDeps) {}

  get state(): TeamState {
    return this._state;
  }
  get lastError(): Error | undefined {
    return this._lastError;
  }

  private set(state: TeamState, team?: Team): void {
    this._state = state;
    this.deps.onState?.(state, team);
  }

  async run<T>(task: TaskSpec, work: (team: Team) => Promise<T>, teamId?: string): Promise<T> {
    let team: Team | undefined;
    try {
      this.set("forming");
      const formed = await this.deps.former.form(task, teamId);
      team = new Team(formed, this.deps.spawner, this.deps.transport, this.deps.roles);
      await team.spawn();
      this.set("ready", team);
      this.set("working", team);
      return await work(team);
    } catch (err) {
      this._lastError = err instanceof Error ? err : new Error(String(err));
      this.set("failed", team);
      throw this._lastError;
    } finally {
      if (team) {
        await team.stop().catch(() => undefined);
        if (this._state !== "failed") this.set("disbanded");
      }
    }
  }
}
