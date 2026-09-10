/**
 * Hermes-Swarm load test — runs a batch of goals through an inline swarm and
 * reports throughput + latency percentiles.
 *
 *   npx tsx examples/swarm/bench.ts [numGoals] [poolSize]
 */
import { createInlineSwarm } from "../../src/swarm-runtime/factory";
import { summarizeLatencies, formatSummary } from "../../src/swarm-runtime/bench/throughput";

async function main(): Promise<void> {
  const numGoals = Number(process.argv[2] ?? 50);
  const poolSize = Number(process.argv[3] ?? 4);

  const swarm = await createInlineSwarm({ capabilities: ["research", "code"], poolSize });
  await swarm.ensurePool();

  console.log(`running ${numGoals} goals with a pool of ${poolSize}…`);
  const wallStart = Date.now();
  const samples = await Promise.all(
    Array.from({ length: numGoals }, async (_v, i) => {
      const t0 = Date.now();
      const goal = await swarm.runGoal(`Benchmark goal ${i}`, { timeoutMs: 30_000 });
      if (goal.status !== "completed") console.error(`  goal ${i} → ${goal.status}`);
      return Date.now() - t0;
    })
  );
  const wallMs = Date.now() - wallStart;

  console.log(formatSummary(summarizeLatencies(samples, wallMs)));
  console.log("grounding rate:", (swarm.groundingRate() * 100).toFixed(1) + "%");
  await swarm.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
