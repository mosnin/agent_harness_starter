#!/usr/bin/env node
/**
 * A local OpenAI-compatible model endpoint for smoke tests.
 *
 * Every product defect this repo's CI missed had the same shape: the code was
 * unit-tested, but nothing ever ran the SHIPPED BINARY against something that
 * behaves like a model. `hades chat` was a stub for months, the swarm CLI
 * could not reach a model at all, and the verification gate certified four
 * wrong answers on the first live run — none of which a unit test could see.
 *
 * This server closes that gap without a key, a bill, or a packet leaving the
 * machine. It speaks `POST /v1/chat/completions` and answers in one of two
 * modes:
 *
 *   --mode solve  (default) parse the `SPEC:` reference embedded in the
 *                 prompt and return the CORRECT answer. Used to prove the
 *                 gate still ACCEPTS good work.
 *   --mode wrong  return a fixed, confidently-formatted WRONG answer. Used to
 *                 prove the gate DECLINES rather than certifies — the exact
 *                 case that failed the product audit.
 *
 * It also serves a real `usage` block, which is what the cost meter
 * (`src/hades/cost/`) reads. `--usage off` OMITS that block, reproducing the
 * providers and proxies that do not report usage — the case where token
 * counts must come back UNKNOWN rather than being silently recorded as zero.
 *
 * Usage:
 *   node scripts/stub-llm.mjs --port 8791 --mode wrong
 *   node scripts/stub-llm.mjs --port 8791 --usage off
 */
import http from "node:http";

function parseArgs(argv) {
  const out = { port: 8791, mode: "solve", usage: "on" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") out.port = Number(argv[++i]);
    else if (argv[i] === "--mode") out.mode = argv[++i];
    else if (argv[i] === "--usage") out.usage = argv[++i];
  }
  if (!Number.isFinite(out.port)) throw new Error("--port must be a number");
  if (out.mode !== "solve" && out.mode !== "wrong") throw new Error('--mode must be "solve" or "wrong"');
  if (out.usage !== "on" && out.usage !== "off") throw new Error('--usage must be "on" or "off"');
  return out;
}

// The same reference math as src/hades/styx/reference-spec.ts. Duplicated
// deliberately: this file is a standalone test double with no build step, and
// an INDEPENDENT implementation is a stronger check than importing the code
// under test — if the two ever disagree, the smoke test fails loudly.
function fnv1aHex(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}

function compute(spec) {
  switch (spec.family) {
    case "arithmetic":
      return String(spec.ops.reduce((a, [o, v]) => (o === "add" ? a + v : o === "sub" ? a - v : a * v), spec.start));
    case "extraction":
      return spec.record[spec.field] ?? "";
    case "transform":
      if (spec.op === "reverse") return spec.text.split("").reverse().join("");
      if (spec.op === "upper") return spec.text.toUpperCase();
      if (spec.op === "lower") return spec.text.toLowerCase();
      if (spec.op === "rot13") return rot13(spec.text);
      return String(spec.text.trim().split(/\s+/).filter(Boolean).length);
    case "checksum":
      return fnv1aHex(spec.text);
    default:
      return "";
  }
}

/** Last well-formed SPEC: line wins — same rule as the real extractor. */
function extractSpec(text) {
  let found;
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t.startsWith("SPEC:")) continue;
    try {
      found = JSON.parse(t.slice(5));
    } catch {
      /* not a usable reference; keep scanning */
    }
  }
  return found;
}

const { port, mode, usage } = parseArgs(process.argv.slice(2));
let calls = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    calls += 1;
    let answer = "42";
    if (mode === "solve") {
      try {
        const payload = JSON.parse(body);
        const text = (payload.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
        const spec = extractSpec(text);
        if (spec) answer = compute(spec);
      } catch {
        /* fall through to the fixed answer */
      }
    }
    // Structurally impeccable either way — a claim, evidence, a confidence.
    // That is the point: shape alone must not be enough to certify.
    const content = JSON.stringify({
      output: answer,
      answer,
      summary: answer,
      claims: [{ statement: `computed ${answer}`, evidence: [answer], confidence: 0.95 }],
      subtasks: [{ description: "solve", requiredCapabilities: [] }],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub",
        object: "chat.completion",
        model: "stub-model",
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        // --usage off omits the block entirely (not zeroes it): the cost
        // meter must then report the call's tokens UNKNOWN. Zeroing it here
        // would test the wrong thing — a provider that says "0 tokens" and a
        // provider that says nothing are different facts.
        ...(usage === "on" ? { usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } } : {}),
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.error(`[stub-llm] mode=${mode} usage=${usage} listening on http://127.0.0.1:${port}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[stub-llm] ${calls} call(s) served; shutting down`);
    server.close(() => process.exit(0));
  });
}
