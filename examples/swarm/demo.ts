/**
 * Runnable Hermes-Swarm demo — no Docker, no API keys.
 *
 *   npx tsx examples/swarm/demo.ts
 *
 * Spins up an inline swarm whose workers use a (mock) research skill, runs a
 * goal end-to-end, and prints the plan, live verification, the grounded
 * synthesis, the evidence provenance, and aggregate metrics — showing that
 * nothing is accepted without clearing the verification gate.
 */
import { createInlineSwarm } from "../../src/swarm-runtime/factory";
import { SkillRegistry, createSkilledExecutor, researchSkill } from "../../src/swarm-runtime/skills/skill";

async function main(): Promise<void> {
  // A mock "web search" so the demo runs offline. Swap for a real search fn.
  const registry = new SkillRegistry([
    researchSkill(async (q) => [
      { title: "Result", url: "https://example.com", snippet: `${q}: the answer is 42, grounded in the source.` },
    ]),
  ]);
  const resolved = registry.resolve(["research"]);

  const executor = createSkilledExecutor(resolved, async (task, tools) => {
    const objective = String((task.input as { objective?: string }).objective ?? task.description);
    const results = (await tools.call("web_search", { query: objective })) as Array<{ snippet: string }>;
    return { output: `Answer for "${objective}": ${results[0].snippet}` };
  });

  const swarm = await createInlineSwarm({
    capabilities: resolved.capabilities,
    poolSize: 3,
    executor,
  });

  swarm.on("goal:planned", (_g, tasks) => console.log(`📋 planned ${tasks.length} tasks`));
  swarm.on("worker:spawned", (r) => console.log(`  ⚙ worker ${r.workerId} online`));
  swarm.on("task:verified", (t, rep) => console.log(`  ✓ verified (${(rep.score * 100) | 0}%): ${t.description.slice(0, 50)}`));
  swarm.on("task:rejected", (t) => console.log(`  ✗ rejected: ${t.description.slice(0, 50)}`));

  console.log("\n🐝 Dispatching goal to the swarm…\n");
  const goal = await swarm.runGoal("What is the answer to the ultimate question?");

  console.log(`\n=== GOAL ${goal.status.toUpperCase()} ===`);
  console.log("Synthesis:", goal.synthesis);

  console.log("\n=== EVIDENCE PROVENANCE ===");
  for (const rec of swarm.listProvenance(goal.id)) {
    for (const c of rec.claims) {
      console.log(`  ${c.grounded ? "✓" : "✗"} ${c.statement}`);
      for (const e of c.tracedEvidence) console.log(`      ↳ evidence: ${e}`);
    }
  }

  console.log("\n=== METRICS ===");
  console.log(JSON.stringify(swarm.metrics(), null, 2));

  await swarm.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
