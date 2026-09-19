# 25 — Hades desktop: how the harness attaches

This repo is the **agent harness**. Hades the product is a **native desktop application** (Tauri window + Node sidecar). The web routes in `src/app/**` and `routes/**` are the SaaS/HTTP surface. They are not the desktop app.

Jev, Qwen, and OpenAI voice run **inside the sidecar**, on the machine. The webview never holds `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY`. Chat uses one Jev RTT (`runPreflight`); greetings still screen, then skip Qwen. Vague asks clarify instead of guessing. Tool loops use one `runToolGate` ask. Drafts that invent facts are replaced with an abstain. Tool stdout, `cap` output, streamed tokens, and `tool_call` / `tool_result` events are locally redacted before they leave the sidecar. Search rerank and injection drop share one Jev ask. The renderer should fire `chat.prefetch` while the user is typing so `chat.send` hits the ask cache.

---

## 1. The two Hades desktops this harness attaches to

| App | What it is | How it talks to this harness |
|---|---|---|
| **Hades desktop** (Tauri + sidecar, historically on `claude/hades-onboarding-cli`) | Native window: chat, swarm, skills, trust. Rust supervisor spawns a Node child and pipes stdio. | `invoke("hades_command")` / `listen("hades_event")` → sidecar stdin/stdout |
| **Hades Cut** ([mosnin/Hades-Cut](https://github.com/mosnin/Hades-Cut)) | Agent-operated macOS recorder/editor (Cap fork). Deterministic `cap` CLI + `cap mcp local`. | Sidecar `desktop.act` → Jev gate → `cap` / `HADES_CUT_BIN` |

The harness does **not** replace ScreenCaptureKit, the `.cap` project model, or the Tauri window. It is the decision + generation brain those apps spawn.

```
┌──────────────────────────────────────────────────────────┐
│ Native Tauri window (Rust)                               │
│   invoke("hades_command")  /  listen("hades_event")      │
│   CSP: default-src 'self'; connect-src 'self' ipc:       │
└──────────────────────────┬───────────────────────────────┘
                           │ stdio NDJSON
                           ▼
┌──────────────────────────────────────────────────────────┐
│ Node sidecar  (this package)                             │
│   createDesktopHost → createHadesHarness                 │
│   Jev screens / routes / Auto Mode                       │
│   Qwen (OpenRouter) generates                            │
│   OpenAI STT/TTS only on voice.turn                      │
│   desktop.act → Jev → cap (Hades Cut)                    │
└──────────────────────────────────────────────────────────┘
```

---

## 2. Install into the desktop app

### 2.1 Sidecar process

From this repo (or `@agent-harness/core`):

```bash
# Dev
npm run desktop:sidecar

# Or point Tauri at the entry
npx tsx src/agents/hades/desktop/sidecar-entry.ts
```

`src-tauri` should spawn that process as a child, write one JSON command per line to stdin, and emit each stdout line as `hades_event`.

Tauri 2 sketch (`src-tauri/src/gui.rs`):

```rust
// invoke("hades_command", { command }) → sidecar stdin
// each sidecar stdout line → app.emit("hades_event", line)
```

The renderer:

```ts
await window.__TAURI__.core.invoke("hades_command", {
  command: { type: "chat.send", text: "Trim silence on the last take." },
});
await window.__TAURI__.event.listen("hades_event", ({ payload }) => {
  const event = JSON.parse(payload);
  if (event.type === "jev.decision") {
    // show Jev <node>: <action> → <decision>
  }
});
```

Headless / tests use `createDesktopHost` in-process — no window, no child.

### 2.2 Environment (sidecar process, not the webview)

```bash
AGENT_PROVIDER=hades
TYPESAFE_API_KEY=...
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...          # voice.turn only
HADES_CUT_BIN=cap           # optional; default `cap` on PATH
```

`detectDesktopInference()` reports `jev+qwen` only when both decision and generation keys are present. Missing Jev keys fail-close every desktop **write**.

### 2.3 Package import

```ts
import { createDesktopHost, runDesktopSidecar } from "@agent-harness/core/hades/desktop";
// or
import { createDesktopHost } from "@/agents/hades/desktop";
```

---

## 3. Wire format

`src/agents/hades/desktop/contract.ts` is the source of truth.

**Commands (renderer → sidecar)**

| type | Body | What happens |
|---|---|---|
| `runtime.start` | — | Emit `runtime.ready` + inference, then `jev.timing` warmup |
| `chat.prefetch` | `text` | Run `runPreflight` into the ask cache (no Qwen) |
| `chat.send` | `text`, `threadId?` | Replay that thread's last 40 turns, then Jev screen/route → Qwen (cache hit if prefetched) |
| `voice.turn` | `audioBase64`, `threadId?` | Same execute gate as `/api/voice`; replays that thread so follow-ups are not cold starts |
| `desktop.act` | `action`, `args?` | Jev desktop policy, then `cap` |
| `approval.respond` | `approvalId`, `approved` | HITL for review-band tools |

**Events (sidecar → renderer)**

`runtime.ready`, `message.delta`, `message.done`, `jev.decision` (includes `latencyMs` / `cached`), `jev.prefetch`, `jev.timing`, `approval.required`, `desktop.result`, `error`, `run.done`.

---

## 4. Desktop Jev hops

`src/agents/jev/desktop.ts`:

| Action | Kind | Jev down |
|---|---|---|
| `targets`, `record_status`, `project_get`, `project_validate` | Read | **Fail open** (inspect is safe) |
| `record_start`, `record_stop`, `project_patch`, `editor_open`, `export` | Write | **Fail closed** — `cap` is never spawned |

A write also blocks when `leaks_screen ≥ 0.7` (passwords / private chat on the display). Execution requires `shouldExecuteDesktop`: `action === "auto"` and `value === "allow"`.

That is the same fail-closed idea as voice (`shouldExecuteVoice`) and Auto Mode, applied to the machine the window is sitting on.

Hades Cut CLI mapping (`HADES_CUT.md`):

| `desktop.act` | `cap` argv |
|---|---|
| `targets` | `cap targets --json` |
| `record_start` | `cap record start --detach --json` |
| `record_stop` | `cap record stop --json` |
| `project_get` / `project_patch` | `cap project config …` |
| `export` | `cap export <project.cap> --output …` |

Local MCP (`cap mcp local`) stays the *typed* control plane for coding agents. The sidecar is what the **Hades window** uses so Jev sits in front of those same verbs.

---

## 5. Theory (why this is not “just call the LLM from the window”)

A desktop agent can record the screen, patch a project file, and write an MP4. Those are not chat completions.

- **Jev** answers “is this capture authorized / secret-bearing / in scope?” in tens of milliseconds, with a typed allow/review/block.
- **Qwen** writes the reply the user reads in the window.
- **`cap`** (or another injected `CapRunner`) is the only process that touches ScreenCaptureKit / the `.cap` document.
- **The webview** is a renderer. It must not hold provider keys (Tauri CSP is `connect-src 'self' ipc:`).

If Jev is unconfigured on the laptop, the window still opens; inspect works; record/export/patch do not. That is a correct install, not a broken one.

---

## 6. What this branch ships vs. other Hades branches

This branch (`cursor/jev-hades-harness-71de`) is the Jev-powered **harness**. It now includes the desktop **attachment**:

- `src/agents/jev/desktop.ts` — policy
- `src/agents/hades/desktop/` — contract, host, sidecar, Cap runner
- `npm run desktop:sidecar`
- tests in `src/agents/__tests__/hades-desktop.test.ts`

The full historical Tauri UI (`src/desktop/ui`, fleet/gateway views, `src-tauri/`) and the Hermes-swarm runtime live on `claude/hades-onboarding-cli`. Hades Cut’s media kernel lives in `mosnin/Hades-Cut`. Point those shells at this sidecar; do not paste keys into the webview.

---

## 7. Debug checklist (desktop)

```bash
npx tsc --noEmit
npx vitest run src/agents/__tests__/hades-desktop.test.ts
```

| Check | Expect |
|---|---|
| `runtime.start` without keys | `inference.kind === "mock"` |
| `desktop.act record_start` without `TYPESAFE_API_KEY` | `jev.decision` block, Cap runner not called |
| `desktop.act targets` | `desktop.result.ok === true` (read) |
| `chat.send` | `jev.decision` then tokens |
| Second `chat.send` on the same `threadId` | Harness `messages` include the prior user + assistant turn |
| `desktop.result` / streamed tokens | API keys in `cap` stdout or Qwen deltas are `[API_KEY]` |
| Tauri CSP | no `https://api.typesafe.ai` from the webview |

---

## 8. Troubleshooting

| Symptom | Cause |
|---|---|
| Record button does nothing / `desktop.result` error `jev-unavailable` | Sidecar missing `TYPESAFE_API_KEY` |
| `cap: command not found` | Set `HADES_CUT_BIN` to the Hades Cut binary |
| Window chats but never shows Jev chips | Renderer is not listening for `jev.decision` |
| Voice always “say that again” | Same gate as the HTTP voice route |

See also [24 — Jev / Hades](24-jev-hades.md).
