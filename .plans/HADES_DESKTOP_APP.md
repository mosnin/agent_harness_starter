# Hades Desktop App + Live TUI — the real product surfaces

Per CLAUDE.md: the product is a **CLI + TUI + native desktop app**, Hermes-class.
This plan builds the two missing surfaces. NOT a web dashboard.

## What "native desktop app" means here (so it is never confused with a website)

A **Tauri** app: a native window (Rust shell, `src-tauri/`) that **spawns and
supervises the local Hades swarm** as a Node sidecar, and renders its UI in the
native webview. The frontend uses web tech *inside the native shell* — like
VS Code, Slack, or Hermes' own desktop app — and talks to the local agent over a
typed stdio IPC, never an HTTP server or a hosted page. It runs offline on the
user's machine.

Toolchain present: `cargo`/`rustc` 1.94. Environment is headless, so agents build
and unit-test all logic and `cargo check` the shell; **launching the window needs
a local build with a display** — no fake screenshots, ever.

## Architecture

```
   native window (Rust, src-tauri)  ── spawns ──►  Node sidecar (src/desktop/core/sidecar.ts)
        │  emit/invoke                                   │  drives the real swarm-runtime (buildSwarm)
        ▼                                                ▼
   renderer (src/desktop/ui/*)  ◄── AppEvent (stdout JSON lines) ──  swarm manager + STYX gate
        └── Command (stdin JSON lines) ──────────────────┘
```

- `src/desktop/ipc/` — the ONE typed Command/AppEvent contract + JSON-line codecs.
- `src/desktop/core/` — the sidecar brain (headless, fully unit-testable) +
  app store (pure reducer over events).
- `src/desktop/ui/` — the renderer: native design system, app shell + sidebar,
  run view, trust/certificate view, skills view. Framework-light and testable.
- `src-tauri/` — the Rust window that owns the sidecar and bridges stdio↔webview.
- `src/swarm-runtime/tui/` — an interactive, keyboard-driven live TUI.

Everything reuses the real engine already built (`src/swarm-runtime`, `src/hades`).
The desktop app and TUI are *views onto the real swarm*, not new logic.

## The 10 parallel workstreams (one Sonnet team each, locked contracts, distinct files)

1. IPC contract + codecs        `src/desktop/ipc/contract.ts`
2. Sidecar brain                `src/desktop/core/sidecar.ts` (+ runtime adapter)
3. App store + selectors        `src/desktop/core/app-store.ts`
4. Native design system         `src/desktop/ui/theme.ts` + `tokens.css`
5. App shell + next-level sidebar `src/desktop/ui/shell.ts` + css
6. Run view (goal/DAG/workers)  `src/desktop/ui/run-view.ts`
7. Trust view (gate + certs)    `src/desktop/ui/trust-view.ts`
8. Skills view (SKILL.md)       `src/desktop/ui/skills-view.ts`
9. Tauri Rust shell + packaging `src-tauri/*` + `src/desktop/sidecar-entry.ts`
10. Interactive live TUI         `src/swarm-runtime/tui/app.ts` + keymap

Each team: build only its files, `tsc`/`cargo check` clean, own vitest green,
never touch index barrels or other teams' files. Central integration + adversarial
audit happens after all 10 return.

## Definition of done (honest)
- All logic unit-tested green; `tsc --noEmit -p tsconfig.lib.json` clean; the full
  suite still passes; `src-tauri` `cargo check` passes.
- The sidecar, fed a goal, drives the real inline swarm and emits the full event
  stream (proven headless, no keys — mock executor; real brain with keys).
- Honest gap stated: GUI window render + packaged installer require a local build
  with a display; those are documented commands, not run here.

## After the teams: audit, then next plan
Central audit for real-vs-mock, contract conformance, and "does it actually run".
Then the next plan of action.

---

## Phase 2 — Make it launchable (10 teams)

The parts exist and are tested; Phase 2 wires them into things that RUN. The
renderer is the Tauri desktop-app frontend (webview inside the native shell),
NOT a website. Highest-value deliverable that runs headless TODAY: `hades tui`.

1. Renderer app/router      `src/desktop/ui/renderer.ts` — mount shell+views, bridge events → store → re-render, clicks → Command.
2. Bridge abstraction       `src/desktop/ui/bridge.ts` — tauriBridge (invoke/listen) + devBridge (in-process Sidecar).
3. Renderer entry + bundler `src/desktop/ui/index.html` + `scripts/build-desktop.mjs` (esbuild → dist/desktop).
4. Tauri window (feature-gated) `src-tauri` gui feature — real window + sidecar bridge behind `--features gui`; default cargo check stays green.
5. `hades tui` command       `src/hades/cli/tui-command.ts` — runs the live TUI over the real swarm, raw stdin, headless. RUNS NOW.
6. Sidecar build + scripts   `scripts/build-sidecar.mjs` + npm `tui`/`desktop:dev`/`desktop:build`.
7. Skills service            `src/desktop/core/skills-service.ts` — real skills.list/save via SkillLibrary + fs.
8. Inference factory         `src/desktop/core/inference.ts` — keyed STYX/real executor; mock without keys.
9. E2E headless proof        `src/desktop/__tests__/e2e-sidecar-swarm.test.ts` — real inline swarm through the Sidecar, full event stream.
10. Docs + adversarial audit `docs/DESKTOP_APP.md` + integration-audit test — real-vs-fake wiring; how to run.

Central integration wires cli.ts (tui), sidecar-entry (skills/inference), scripts.

## Phase 3 — the "whatever after" (queued; dispatched after the Phase 2 audit)
- Command palette + keyboard-first nav across the desktop app.
- Certificate detail + verify-a-cert flow (drop a cert, check its ed25519 + trace).
- Live V-TPH$ panel wired to `bench vtph` with a keyed run.
- TUI: split-pane logs, worker drill-in, goal history replay.
- Packaged installers (dmg/AppImage/msi) via `cargo tauri build`, documented + CI.
- Real head-to-head run harness surfaced in-app once keys are present.
