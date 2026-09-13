#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const DEADLINE_MS = 90_000;
const POLL_MS = 1_000;

function usage() {
  return `Usage: node check-plugins-live.mjs --plugin-root PATH [options]

Smoke-check a Hades MCP stdio plugin server.

Options:
  --plugin-root PATH  Plugin directory containing scripts/server.mjs (required)
  --browser           Check the hades_browser tools instead of hades tools
  --root PATH         Root passed to a live delegation
  --profile ID        Profile passed to a live delegation
  --run               Perform a bounded live delegation and poll it to completion
  -h, --help          Show this help

Without --run, the command only initializes the server and verifies its tools.`;
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const options = {
    browser: false,
    run: false,
    pluginRoot: undefined,
    root: undefined,
    profile: undefined,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--browser") options.browser = true;
    else if (argument === "--run") options.run = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (["--plugin-root", "--root", "--profile"].includes(argument)) {
      const value = argv[++i];
      if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
      const key = argument === "--plugin-root" ? "pluginRoot" : argument.slice(2);
      options[key] = value;
    } else fail(`Unknown argument: ${argument}`);
  }
  if (!options.help && !options.pluginRoot) fail("--plugin-root is required");
  return options;
}

function assistantOutput(message) {
  if (!message || message.role !== "assistant") return undefined;
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    const text = message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  return undefined;
}

function parseToolPayload(result) {
  if (result?.isError) {
    const detail = result.content?.find((part) => part?.type === "text")?.text;
    fail(detail ? `Tool error: ${detail}` : "Tool returned isError");
  }
  const text = result?.content?.find((part) => part?.type === "text")?.text;
  if (typeof text !== "string") fail("Tool returned no JSON text content");
  try {
    return JSON.parse(text);
  } catch {
    fail("Tool returned invalid JSON text content");
  }
}

function admissionFailed(payload) {
  const admission = payload?.admission;
  return (
    payload?.state === "failed" ||
    payload?.error != null ||
    admission === "failed" ||
    admission?.status === "failed" ||
    admission?.failed === true
  );
}

function taskIdFrom(payload) {
  return payload?.id ?? payload?.taskId ?? payload?.conversationId;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const server = resolve(options.pluginRoot, "scripts", "server.mjs");
  await access(server);

  const childArgs = [server, ...(options.browser ? ["--browser"] : [])];
  const child = spawn(process.execPath, childArgs, {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map();
  const timers = new Set();
  const delayRejectors = new Set();
  let nextId = 1;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    for (const reject of delayRejectors) reject(new Error("MCP server stopped"));
    delayRejectors.clear();
    for (const { reject } of pending.values()) reject(new Error("MCP server stopped"));
    pending.clear();
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };

  const deadline = setTimeout(() => {
    const error = new Error(`Deadline exceeded after ${DEADLINE_MS / 1000} seconds`);
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
    for (const reject of delayRejectors) reject(error);
    delayRejectors.clear();
    cleanup();
  }, DEADLINE_MS);
  timers.add(deadline);

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      for (const { reject } of pending.values()) reject(new Error("Invalid JSON-RPC response"));
      pending.clear();
      return;
    }
    if (response.id === undefined || response.id === null) return;
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    if (response.error) {
      waiter.reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
    } else waiter.resolve(response.result);
  });

  const exited = new Promise((_, reject) => {
    child.once("error", (error) => reject(new Error(`Unable to start MCP server: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (!stopped) reject(new Error(`MCP server exited (${signal ?? `code ${code}`})`));
    });
  });

  function request(method, params = undefined) {
    if (stopped) return Promise.reject(new Error("MCP server is not running"));
    const id = nextId++;
    const response = new Promise((resolveResponse, reject) => {
      pending.set(id, { resolve: resolveResponse, reject });
    });
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return Promise.race([response, exited]);
  }

  function notify(method, params = undefined) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function delay(ms) {
    return new Promise((resolveDelay, rejectDelay) => {
      delayRejectors.add(rejectDelay);
      const timer = setTimeout(() => {
        timers.delete(timer);
        delayRejectors.delete(rejectDelay);
        resolveDelay();
      }, ms);
      timers.add(timer);
    });
  }

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hades-live-smoke-check", version: "1.0.0" },
    });
    notify("notifications/initialized");

    const prefix = options.browser ? "hades_browser" : "hades";
    const expected = ["delegate", "status", "continue", "cancel"].map(
      (operation) => `${prefix}_${operation}`,
    );
    const listed = await request("tools/list");
    const names = new Set(listed?.tools?.map((tool) => tool?.name));
    const missing = expected.filter((name) => !names.has(name));
    if (missing.length) fail(`Missing expected tools: ${missing.join(", ")}`);
    console.log(`tools: ${expected.join(", ")}`);

    if (!options.run) return;

    const requestId = randomUUID();
    const prompt = options.browser
      ? "Use only the hades_browser browser.listTabs tool. Return the active tab title only. Do not read page content and do not navigate."
      : "Reply exactly: Hades plugin delegation verified without tools. Do not use tools.";
    const delegateArguments = { requestId, input: prompt };
    if (options.root) delegateArguments.root = options.root;
    if (options.profile) delegateArguments.profile = options.profile;

    const admitted = parseToolPayload(
      await request("tools/call", {
        name: `${prefix}_delegate`,
        arguments: delegateArguments,
      }),
    );
    if (admissionFailed(admitted)) fail("Delegation admission failed");
    const taskId = taskIdFrom(admitted);
    if (typeof taskId !== "string" || !taskId) fail("Delegation returned no task ID");
    console.log(`requestId: ${requestId}`);
    console.log(`taskId: ${taskId}`);

    while (true) {
      const status = parseToolPayload(
        await request("tools/call", {
          name: `${prefix}_status`,
          arguments: { id: taskId },
        }),
      );
      if (admissionFailed(status)) fail("Delegation admission failed");
      if (status?.progress?.error) {
        const detail = typeof status.progress.error === "string" ? status.progress.error : "reported";
        fail(`Delegation progress error: ${detail}`);
      }
      const messages = Array.isArray(status?.messages) ? status.messages : [];
      const output = messages.map(assistantOutput).filter(Boolean).at(-1);
      if (status?.progress?.running === false && output) {
        console.log(`assistant: ${output}`);
        return;
      }
      await delay(POLL_MS);
    }
  } finally {
    cleanup();
  }
}

main().catch((error) => {
  console.error(`check-plugins-live: ${error.message}`);
  process.exitCode = 1;
});
