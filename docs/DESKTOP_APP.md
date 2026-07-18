# Hades Desktop App

This is a native desktop application — the way Hermes ships a macOS / Linux /
Windows desktop app — not a website, not a hosted dashboard, and not a
Next.js page. `src/app/**` in this repo is unrelated starter-kit scaffolding;
none of it is used by anything documented here.

## Architecture, in words

```
┌─────────────────────────────────────────────────────────────┐
│ Native Tauri window (src-tauri/, Rust)                       │
│  - src-tauri/src/main.rs: a small, dependency-free process    │
│    supervisor. Spawns the Node sidecar as a child process,    │
│    pipes this process's stdin/stdout straight through to it,  │
│    and restarts it (bounded retries, linear backoff) if it    │
│    crashes.                                                   │
│  - src-tauri/tauri.conf.json: the real Tauri app shell config │
│    (window, webview, CSP, bundle targets). Read by the         │
│    `cargo tauri` CLI, not by `cargo check`/`cargo build`.      │
│                                                                 │
│   spawns, pipes stdio                                          │
│        │                                                       │
│        ▼                                                       │
│  Node sidecar (src/desktop/sidecar-entry.ts + core/)           │
│  - Reads newline-delimited Command JSON from stdin, decodes    │
│    it against the shared wire contract, drives the REAL swarm  │
│    (src/swarm-runtime, via buildSwarm), and writes newline-     │
│    delimited AppEvent JSON back out to stdout.                 │
│  - core/sidecar.ts (Sidecar class) owns all of that command     │
│    handling / engine-shape-to-wire-view mapping. realSwarmFactory│
│    wires it to the actual SwarmManager — no fake engine here.   │
│                                                                 │
│        │ same IPC contract, different transport                │
│        ▼                                                       │
│  Webview renderer (src/desktop/ui/, loaded by src-tauri as the │
│  window's `frontendDist`)                                      │
│  - ui/main.ts boots ui/renderer.ts (mountApp/createApp), which  │
│    wires a Bridge (ui/bridge.ts) to the pure app-store reducer  │
│    (core/app-store.ts) and the pure view renderers (shell,      │
│    run-view, trust-view, skills-view).                          │
│  - tauriBridge talks to the Rust supervisor via                │
│    window.__TAURI__.invoke("hades_command", …) /                │
│    .listen("hades_event", …). devBridge runs a Sidecar           │
│    in-process instead, with no Tauri, no window, no child        │
│    process — used for tests and for `desktop:dev` without a      │
│    display.                                                     │
└─────────────────────────────────────────────────────────────┘
```

The webview is a frontend *inside* the native shell, the same relationship
Slack's or VS Code's Electron/Tauri-style windows have to their web content —
not a page served over HTTP to a browser. `tauri.conf.json`'s CSP
(`default-src 'self'; connect-src 'self' ipc: http://ipc.localhost`) reflects
that: the renderer talks only to the local IPC bridge, never out over the
network.

The single source of truth for the wire format both sides speak is
`src/desktop/ipc/contract.ts`: a `Command` union (renderer → sidecar) and an
`AppEvent` union (sidecar → renderer), each with runtime type guards and
`encode*`/`decode*` codecs — pure, dependency-free, no I/O.

## What runs today, honestly

**Runs, verified in this environment:**

- **`hades tui`** — a genuine interactive, keyboard-driven terminal
  dashboard, no display required. `src/hades/cli/tui-command.ts` builds a
  real swarm via `realSwarmFactory()`, adapts it to the `TuiApp` state
  machine (`src/swarm-runtime/tui/app.ts`), polls `SwarmHandle.snapshot()`,
  and renders frames straight to stdout; raw-mode stdin drives goal dispatch,
  pool scaling, and cancellation. Every dependency (streams, the swarm
  factory, the clock, the poll interval) is injectable, which is what makes
  `runTuiInteractive({ once: true, ... })` fully unit-testable headless.
- The **Node sidecar** end-to-end: `src/desktop/sidecar-entry.ts` reads
  `Command` lines, drives a swarm, and writes `AppEvent` lines back out. It
  wires a real `SkillsService` (`src/desktop/core/skills-service.ts`, backed
  by the actual `SKILL.md` library) and a real `detectInference()` call by
  default, so `skills.list`/`skills.save` and the startup inference-mode log
  line are live, not stubbed. `runSidecar` is also exercised directly against
  a fake input stream and a scripted fake swarm factory in tests — no real
  process, no real engine required to prove the plumbing works on its own.
- The **real inline swarm** underneath both surfaces: `realSwarmFactory()` in
  `src/desktop/core/sidecar.ts` calls `buildSwarm` from
  `src/swarm-runtime/server/build-swarm.ts` — the exact same manager/worker
  pool the REST dashboard and `hermes-swarm` CLI use. Dispatching a goal
  through the sidecar or the TUI drives the real `SwarmManager`, not a stub.
- **Headless**: none of the above needs a display, a webview, or `cargo
  tauri`. `Sidecar`, `runSidecar`, `devBridge`, `createApp`, and every pure
  view renderer run under Node/Vitest with no DOM required for their
  string-in/string-out logic (`mountApp`, which touches real DOM APIs, is
  covered separately with a fake DOM-shaped `HTMLElement`-like root).
- **Unit + integration tests green**: `npx vitest run src/desktop/` passes
  (contract round-trips, sidecar command handling, devBridge/tauriBridge,
  app-store reduce/selectors, every view renderer, the theme token system,
  and the desktop bundler itself). See
  `src/desktop/__tests__/integration-audit.test.ts` for an adversarial pass
  specifically aimed at proving the wiring isn't fake.
- **The webview bundle actually builds**: `scripts/build-desktop.mjs` bundles
  `src/desktop/ui/main.ts` (+ its CSS) with esbuild into
  `dist/desktop/{main.js,main.css,index.html}`. It marks `node:*` specifiers
  external — `devBridge`'s in-process fallback statically imports the
  Node-only sidecar (which pulls in `node:events`/`node:crypto`/`node:http`
  through `buildSwarm`), and that path never actually runs inside the shipped
  Tauri webview (`main.ts` only calls `devBridge()` when `window.__TAURI__`
  is absent), but esbuild still has to resolve every static import to bundle
  at all. Marking Node builtins external is what makes that resolve without
  vendoring server code into a browser artifact — worth knowing if you ever
  change what `devBridge` imports.
- **`cargo check` compiles the Rust supervisor**: `src-tauri/src/main.rs` is
  a genuine, dependency-free process supervisor (spawn `node <sidecar>`, pipe
  stdio, bounded-retry restart on crash) that builds and unit-tests with
  nothing but the Rust standard library — no `tauri` crate dependency, on
  purpose, so it compiles in a headless sandbox.

**Needs a local machine with a display, not run here:**

- `cargo tauri dev` / `cargo tauri build` — these read `tauri.conf.json`,
  generate the actual Tauri application bindings around the supervisor logic
  above, open a real native window, and load the webview bundle into it.
  That requires platform webview libraries (WebKitGTK on Linux, WebView2 on
  Windows, WKWebView on macOS) and the `cargo tauri` CLI, none of which exist
  in this headless build environment. It was not attempted here, and no
  screenshot of a rendered window exists anywhere in this change — there is
  nothing to screenshot without that step.
- Packaged installers (`.dmg`, `.deb`, `.AppImage`, `.msi`, `.nsis` — see
  `bundle.targets` in `tauri.conf.json`) are produced by `cargo tauri build`
  and likewise require that local toolchain.

## Running each surface

### TUI (terminal, no display needed)

```bash
npm run tui
# equivalently: npx tsx src/hades/bin/hades.ts tui
```

This drives the real interactive dashboard described above — no separately
running server, no display, raw-mode keyboard input (`g` dispatch a goal,
`+`/`-` scale the pool, `c` cancel, `q` quit). `hades <subcommand> --help`
(e.g. `npx tsx src/hades/bin/hades.ts tui --help`) works the same way.

A second, non-interactive TUI also exists — `npx tsx
src/swarm-runtime/cli.ts tui` — which polls a separately running dashboard's
`GET /api/state` (`npx tsx src/swarm-runtime/cli.ts serve`) once a second
and renders it via `renderTui`. That one predates `hades tui` and is useful
for watching a dashboard someone else started; `hades tui` above is the
self-contained surface this doc otherwise means by "the TUI."

### Desktop dev (webview, needs a display)

```bash
npm run desktop:dev
```

This runs `desktop:build` (below) and then `cargo tauri dev --features
gui`. Honesty caveat: `src-tauri/Cargo.toml` in this snapshot is still the
dependency-free, headless-only crate described above — it declares no `gui`
feature and no `tauri` dependency yet, so this script does not yet succeed
even on a machine with the Tauri CLI installed. Wiring an actual `gui`
Cargo feature (real `tauri` dependency, window/webview bootstrap) is the
remaining step to make `desktop:dev`/`desktop:build`'s Tauri half real; the
sidecar + webview bundle halves below already work standalone.

`tauri.conf.json`'s `beforeDevCommand` (`npm run dev:desktop-renderer`) and
`devUrl` (`http://localhost:5183`) describe an intended live-reload loop
that also isn't wired yet; `npm run desktop:build:ui` (below) is the
one-shot equivalent that already works today.

### Desktop build (packaged app, needs a display + local toolchain)

```bash
npm run desktop:build
# = npm run desktop:build:sidecar && npm run desktop:build:ui
```

- `desktop:build:sidecar` (`node scripts/build-sidecar.mjs`) bundles
  `src/desktop/sidecar-entry.ts` into a self-contained, CJS,
  directly-executable `dist/desktop/sidecar-entry.js` — this half already
  runs headless and is verified in this environment.
- `desktop:build:ui` (`node scripts/build-desktop.mjs`) bundles the webview
  frontend into `dist/desktop/{main.js,main.css,index.html}` — also verified
  headless.
- Producing the actual installer still requires `cd src-tauri && cargo tauri
  build` on a local machine with a display, the platform webview libs, and
  (per the caveat above) a `gui` Cargo feature that hasn't landed in
  `Cargo.toml` yet. `cargo check` (no display needed) does pass today.

### Running the test suites (works everywhere, including here)

```bash
npx vitest run src/desktop/                                    # all desktop unit/integration tests
npx vitest run src/desktop/__tests__/integration-audit.test.ts # the adversarial audit specifically
npx tsc --noEmit -p tsconfig.lib.json                           # typechecks src/desktop/**/*.ts
cd src-tauri && cargo check && cargo test                       # Rust supervisor compiles + its own unit tests
```

## Keys — what actually calls a model

The swarm's worker executor is decided by `src/desktop/core/inference.ts`:

- **No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` set** → `detectInference`
  returns `{ kind: "mock", detail: "no keys — deterministic mock" }`. The
  mock executor makes **zero** network calls, is a pure deterministic
  transform of the prompt (word/char counts), always prefixes its output
  `"[mock] "`, and always reports `usd: 0` / `tokensIn: 0` / `tokensOut: 0` —
  it is labeled and cost-honest, never a fake positive result.
- **Either key present** (or a `ModelClient` is injected directly) →
  `createExecutor` builds a real executor over `buildClientFromEnv`
  (`src/hades/cli/bench-command.ts`, the same key-detection the `hades bench`
  CLI uses), and `detail` truthfully reports which provider(s) backed the
  decision.

Set `ANTHROPIC_API_KEY` and/or `OPENAI_API_KEY` in the environment the
sidecar process inherits (i.e. wherever `src-tauri/src/main.rs` or
`npx tsx src/swarm-runtime/cli.ts` is launched from) to give the desktop
app's swarm a real brain instead of the offline mock.
