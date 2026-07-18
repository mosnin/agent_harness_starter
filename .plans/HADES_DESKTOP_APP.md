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
