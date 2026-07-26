# Hermes-Swarm examples

## `demo.ts` — inline swarm, no Docker, no API keys

```bash
npx tsx examples/swarm/demo.ts
```

Spins up an inline swarm whose workers use a (mock) research skill, runs a goal
end-to-end, and prints the plan, live verification, the grounded synthesis, the
evidence provenance, and aggregate metrics. Everything the swarm accepts has
cleared the anti-hallucination verification gate — the provenance section shows
exactly which evidence backed each claim.

Swap the mock `researchSkill(async q => …)` search function for a real one
(Tavily, SerpAPI, your own index) and point `createChat({provider, model})` at
any OpenAI-compatible or Anthropic endpoint to run real LLM-backed workers.

## Going further

- **Web dashboard + REST:** `npm run swarm:dashboard` → http://127.0.0.1:8080
- **CLI:** `npm run swarm -- run "<goal>" --mode process --workers 4`
- **Full container swarm:** `docker compose -f docker-compose.swarm.yml up --build`
- **Terminal UI:** `npm run swarm -- tui --manager-url http://127.0.0.1:8080`

See [`docs/24-swarm-runtime.md`](../../docs/24-swarm-runtime.md) and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for the full reference.
