import type { SwarmManager } from "../manager/manager";

export interface StructuredLogRecord {
  ts: number;
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

export type LogSink = (record: StructuredLogRecord) => void;

/** Default sink: one JSON object per line to stdout (ndjson). */
export const stdoutJsonSink: LogSink = (r) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(r));
};

/**
 * Subscribe to a manager's lifecycle events and emit them as structured JSON log
 * records — the machine-readable audit stream that complements the human
 * dashboard. Wire `sink` to stdout (ndjson), a file, or a log shipper. Returns a
 * detach function.
 */
export function attachStructuredLogging(
  manager: SwarmManager,
  sink: LogSink = stdoutJsonSink,
  now: () => number = () => Date.now()
): () => void {
  const emit = (level: StructuredLogRecord["level"], event: string, fields: Record<string, unknown>) =>
    sink({ ts: now(), level, event, fields });

  const onSpawn = (r: { workerId: string }) => emit("info", "worker.spawned", { workerId: r.workerId });
  const onKilled = (r: { workerId: string }, reason: string) =>
    emit("warn", "worker.killed", { workerId: r.workerId, reason });
  const onDead = (r: { workerId: string }, reason: string) =>
    emit("warn", "worker.dead", { workerId: r.workerId, reason });
  const onVerified = (t: { id: string; goalId: string }, rep: { score: number }) =>
    emit("info", "task.verified", { taskId: t.id, goalId: t.goalId, score: rep.score });
  const onRejected = (t: { id: string; goalId: string }) =>
    emit("warn", "task.rejected", { taskId: t.id, goalId: t.goalId });
  const onFailed = (t: { id: string; goalId: string }, reason: string) =>
    emit("error", "task.failed", { taskId: t.id, goalId: t.goalId, reason });
  const onGoalDone = (g: { id: string; status: string }) =>
    emit("info", "goal.completed", { goalId: g.id, status: g.status });
  const onGoalFail = (g: { id: string }, reason: string) =>
    emit("error", "goal.failed", { goalId: g.id, reason });
  const onGoalAbort = (g: { id: string }, reason: string) =>
    emit("warn", "goal.aborted", { goalId: g.id, reason });

  manager.on("worker:spawned", onSpawn);
  manager.on("worker:killed", onKilled);
  manager.on("worker:dead", onDead);
  manager.on("task:verified", onVerified);
  manager.on("task:rejected", onRejected);
  manager.on("task:failed", onFailed);
  manager.on("goal:completed", onGoalDone);
  manager.on("goal:failed", onGoalFail);
  manager.on("goal:aborted", onGoalAbort);

  return () => {
    manager.off("worker:spawned", onSpawn as never);
    manager.off("worker:killed", onKilled as never);
    manager.off("worker:dead", onDead as never);
    manager.off("task:verified", onVerified as never);
    manager.off("task:rejected", onRejected as never);
    manager.off("task:failed", onFailed as never);
    manager.off("goal:completed", onGoalDone as never);
    manager.off("goal:failed", onGoalFail as never);
    manager.off("goal:aborted", onGoalAbort as never);
  };
}
