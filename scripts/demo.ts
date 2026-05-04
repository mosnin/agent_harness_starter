#!/usr/bin/env npx tsx
/**
 * Zero-config agent demo — streams a response to your terminal.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... npx tsx scripts/demo.ts "What can you do?"
 *
 * Requirements: OPENAI_API_KEY in environment. Nothing else.
 * No Next.js, no database, no auth wiring needed.
 */

import { createCustomHarness } from "../src/agents/core";
import { config as loadEnv } from "dotenv";

// Load .env.local if present (optional — works without it if OPENAI_API_KEY is in env)
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

const message = process.argv[2] ?? "Hello! What can you do?";

const agent = createCustomHarness({
  name: "DemoAgent",
  instructions:
    "You are a helpful assistant. Be concise — this is a terminal demo.",
  model: "gpt-4o-mini",
});

console.log(`\n[DemoAgent] User: ${message}\n[DemoAgent] Response: `);

const stream = agent.stream({
  messages: [{ role: "user", content: message }],
});

let hadError = false;
for await (const event of stream) {
  if (event.type === "message_delta") {
    process.stdout.write(event.delta);
  } else if (event.type === "done") {
    process.stdout.write("\n");
  } else if (event.type === "error") {
    console.error(`\n[error] ${event.error}${event.code ? ` (${event.code})` : ""}`);
    if (event.remediation) console.error(`[hint]  ${event.remediation}`);
    hadError = true;
  }
}

process.exit(hadError ? 1 : 0);
