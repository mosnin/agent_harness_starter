// Candidate receives inputs only, never expected oracle outputs.
import { pathToFileURL } from "node:url";
let text = "";
for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
const input = structuredClone(request.input);
const before = JSON.stringify(input);
const controller = new AbortController();
if (request.signal?.aborted) controller.abort();
const timer = request.signal?.abortAfterMs === undefined ? undefined : setTimeout(() => controller.abort(), request.signal.abortAfterMs);
try {
  const module = await import(pathToFileURL(process.argv[2]).href);
  const started = performance.now();
  const value = await module.solve(input, controller.signal);
  process.stdout.write(JSON.stringify({ outcome: "returned", value, durationMs: performance.now() - started, mutated: before !== JSON.stringify(input) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ outcome: "threw", name: error?.name, mutated: before !== JSON.stringify(input) }));
} finally { clearTimeout(timer); }
