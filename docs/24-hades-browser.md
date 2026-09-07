# 24. Hades Browser integration

This harness is one half of a pair. The other half is
[`mosnin/hades-browser`](https://github.com/mosnin/hades-browser) — a Mac
browser on Chromium built for AI agents. Its
[`docs/HANDBOOK.md`](https://github.com/mosnin/hades-browser/blob/main/docs/HANDBOOK.md)
is the complete map of both sides; this page covers only what lives *here* and
how to wire it.

## What this repo carries

| Piece | Where | Purpose |
| --- | --- | --- |
| Account + sync API | `routes/hades/v1/**/route.ts` → `src/agents/hades/account/` | The browser's sign-up / sign-in / sign-out / refresh and its one-round-trip sync. Drop the route files into your Next.js app under `src/app/api/hades/v1/…`. |
| Browser bridge client | `src/agents/hades/browser/client.ts`, `tools.ts` | Connects to a running Hades Browser on loopback and exposes it to agents as tools. Also answers the browser's `ai.complete` requests (its "Max" features). |
| Per-agent wallets | `src/agents/hades/wallet/` | One EVM + one Solana account per agent, derived deterministically from a single mnemonic, under a spend policy with a human-approval hook. |
| Protocol mirror | `src/agents/hades/protocol.ts` | The slice of `@hades/protocol` v1.0.0 this harness uses, wire-identical. Import the package instead once it is published. |

## Configuration

```bash
# .env
HADES_WALLET_MNEMONIC=   # BIP-39 phrase every agent wallet derives from. Generate once, never rotate casually.
HADES_AUTH_SECRET=       # ≥ 32 chars; signs the browser's session JWTs (openssl rand -hex 32)
HADES_BROWSER_TOKEN=     # pairing token from the browser: Settings → Agents
HADES_BROWSER_URL=ws://127.0.0.1:8787   # the browser shows the port it actually bound
```

Point the browser at this deployment with
`HADES_API_BASE=https://your-app.example/api/hades`.

## Wiring it in

```ts
import {
  HadesWalletRegistry,
  setHadesWalletRegistry,
  HadesBrowserClient,
  setHadesBrowserClient,
} from "@/agents/hades";

setHadesWalletRegistry(
  HadesWalletRegistry.fromEnv({
    onApprovalRequired: async (request) => escalateToHuman(request),
  }),
);

const browser = new HadesBrowserClient({
  token: process.env.HADES_BROWSER_TOKEN!,
  agents: [{ id: "researcher", name: "Researcher", allowedTools: [] }],
});
await browser.connect();
setHadesBrowserClient(browser);
```

Then give an agent the tool names from `HADES_WALLET_TOOL_NAMES` and
`HADES_BROWSER_TOOL_NAMES`, and pass `meta: { agentId }` in the tool context —
that is what decides whose wallet and whose consent grant apply.

### Tools an agent sees

| Tool | Browser consent it needs |
| --- | --- |
| `browser_list_workspaces`, `browser_list_tabs` | `read-metadata` |
| `browser_read_page` | `read-content` |
| `browser_open_tab` | `control-tabs` |
| `browser_list_collections`, `browser_search_collections` | `collections` (only collections the user marked agent-readable) |
| `browser_activity_digest` | `activity` (only while the user has tracking on) |
| `browser_snapshot`, `browser_extract`, `browser_wait_for` | `read-content` — agent mode's eyes: the page as a numbered accessibility tree |
| `browser_click`, `browser_type`, `browser_press`, `browser_select`, `browser_scroll` | `control-page` — agent mode's hands. Run only in the browser's Agent space or on a site the user granted; stop when the user touches the page; ask before paying, sending, deleting; never type credentials. Pass `meta.runId` to attribute them to a run. |
| `browser_remember`, `browser_recall` | `context` — the shared memory, synced sealed to the desktop app |
| `wallet_address`, `wallet_balance`, `wallet_policy`, `wallet_sign_message`, `wallet_send` | the agent's own wallet; `wallet_send` runs the spend policy and may escalate through `onApprovalRequired` |

Consent is granted per agent by the user inside the browser, and additionally
scoped per workspace (`full` / `metadata-only` / `none`). A refused call comes
back as a `ToolResult` with an error code, never as a dropped frame.

### Runs

Wrap a multi-step task in a run so the browser can show it: `client.startRun({ runId, agentId, title, threadId })`,
`client.reportStep(...)` per step, `client.askUser(runId, prompt, options)` when you need the person,
`client.finishRun(runId, "done", summary, artifacts)` at the end. Pass `meta.runId` in the tool context so
each page action badges the tab it drives. Handle `onTaskControl` — the person can pause, resume, stop or
answer from the browser, and a paused run's page actions fail with `paused` until they resume.

## The sync endpoint, in one paragraph

`POST /v1/sync` receives `{ deviceId, since, records }` and returns
`{ cursor, records }`. Every record is
`{ type, id, revision, updatedAt, deviceId, enc: { v: 1, iv, ct } }` — the
payload is AES-256-GCM under a key the browser derives from the user's password
and never sends. The server keeps the newest copy by revision (device id breaks
ties, the same rule the browser runs), returns envelopes untouched, and
**rejects a record whose payload arrives in the clear** with 400. Store adapters
must treat `enc` as an opaque blob; there is nothing to index. Rows written by a
deployment from before the envelope (plaintext `data`) are returned as they are;
the browser imports them once and re-uploads them sealed.

## Direction of trust

The browser **listens** on `127.0.0.1` and the harness dials in with a token
the user copied out of the browser. Browsing data therefore never crosses a
network to reach an agent unless the user points a remote harness at their
machine themselves. Keep it that way: do not add a mode where the browser
connects outward.

## Tests

`src/agents/hades/__tests__/` — `account.test.ts` (JWTs, password hashing,
sync merge and the plaintext refusal), `browser-client.test.ts` (handshake,
version gate, tool round-trips), `agent-wallet.test.ts` (derivation, policy,
ledger). Run with `npm test`.
