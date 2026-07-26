import { describe, it, expect, afterEach } from "vitest";
import { HttpControlPlane } from "../bus/http-control-plane";
import { HttpWorkerClient } from "../bus/http-worker-client";
import type { WorkerResult, WorkerTask } from "../types";

let plane: HttpControlPlane | undefined;
afterEach(async () => {
  await plane?.close();
  plane = undefined;
});

function makeTask(id: string): WorkerTask {
  return {
    id,
    goalId: "g",
    description: "do a thing",
    requiredCapabilities: ["general"],
    input: {},
    dependsOn: [],
    priority: 5,
    status: "pending",
    attempts: 0,
    maxAttempts: 3,
    createdAt: Date.now(),
  };
}

describe("HttpControlPlane ↔ HttpWorkerClient", () => {
  it("registers, dispatches a task, and reports a result over HTTP", async () => {
    const port = 39117;
    plane = new HttpControlPlane({ port, authToken: "secret", pollTimeoutMs: 2000 });
    await plane.listen();

    const results: WorkerResult[] = [];
    plane.onResult((r) => results.push(r));

    const client = new HttpWorkerClient({ managerUrl: `http://127.0.0.1:${port}`, authToken: "secret" });
    await client.register({ workerId: "w1", capabilities: ["general"] });

    plane.enqueueTask(makeTask("task-1"));
    const task = await client.pullTask("w1", 2000);
    expect(task?.id).toBe("task-1");

    await client.reportResult({
      taskId: "task-1",
      workerId: "w1",
      output: "done",
      claims: [],
      toolTrace: [],
      startedAt: 0,
      finishedAt: 1,
    });
    // allow the POST handler to run
    await new Promise((r) => setTimeout(r, 50));
    expect(results.length).toBe(1);
    expect(results[0].output).toBe("done");
  });

  it("rejects unauthorized requests", async () => {
    const port = 39118;
    plane = new HttpControlPlane({ port, authToken: "secret" });
    await plane.listen();

    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 204 when no task is available before the poll times out", async () => {
    const port = 39119;
    plane = new HttpControlPlane({ port, authToken: "secret", pollTimeoutMs: 300 });
    await plane.listen();
    const client = new HttpWorkerClient({ managerUrl: `http://127.0.0.1:${port}`, authToken: "secret" });
    await client.register({ workerId: "w1", capabilities: ["general"] });
    const task = await client.pullTask("w1", 300);
    expect(task).toBeNull();
  });
});
