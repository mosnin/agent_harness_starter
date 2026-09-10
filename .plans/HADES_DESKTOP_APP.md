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

## Phase 2 — COMPLETE ✅ (10/10 workstreams, audited)
All landed, verified headless, pushed: renderer entry+bundler, `hades tui` (runs
now — spawns a real inline worker, renders live frames), self-contained packaged
sidecar, real SkillsService + honest inference-mode reporting, E2E sidecar→swarm
proof, docs + adversarial integration-audit. Verify: full vitest **2165 pass**,
`tsc -p tsconfig.lib.json` clean, `cargo check` clean, sidecar runs standalone.
Audit caught + fixed one real mapper bug (empty-id phantom views → `idStr` drops
them). Known gap: no `gui` Cargo feature yet → Phase 3 team 1.

## Phase 3 — the "whatever after" (10 teams; distinct NEW files, locked contracts)

Rule (same as Phase 2): each team builds ONLY its listed files, never edits
`ipc/contract.ts`, index barrels, or another team's/existing files. Teams define
their own local input types; any `contract.ts` extension is CENTRAL integration
(mine). Each keeps `tsc -p tsconfig.lib.json` clean + its own vitest green.

Builders:
1. gui-window        `src-tauri/*` — optional `tauri` dep + `gui` cargo feature; a
   `#[cfg(feature="gui")]` window module bridging IPC ↔ spawned sidecar. Default
   `cargo check`/`cargo test` (no feature) STAY green. Only team touching src-tauri.
2. command-palette   `src/desktop/ui/command-palette.ts` — palette state machine +
   render; entries map to EXISTING `Command`s. Pure, testable.
3. cert-verify       `src/desktop/core/cert-verify.ts` + `src/desktop/ui/cert-view.ts`
   — verify a dropped certificate (real ed25519 via `src/*/styx/certificate`) + detail view.
4. vtph-panel        `src/desktop/ui/vtph-panel.ts` — live V-TPH$ panel; pure render
   over a self-defined typed input (no fabricated numbers).
5. tui-panes         `src/swarm-runtime/tui/panes.ts` — split-pane logs + worker
   drill-in pure renderers (must NOT touch tui/app.ts).
6. tui-history       `src/swarm-runtime/tui/history.ts` — goal-run recorder + frame replay.
7. head-to-head      `src/desktop/core/head-to-head.ts` — hades-vs-hermes head-to-head
   result surfaced through the sidecar, reusing the real hierarchy harness.
8. installers-ci     `docs/INSTALL.md` + `.github/workflows/desktop-build.yml` +
   `scripts/package-desktop.mjs` — documented packaging + CI, honest about display need.

Adversarial verifiers (try to BREAK the builders — fake wiring, hardcoded numbers,
contract violations, unverified claims; write regression tests where they find gaps):
9.  verify-A `src/desktop/__tests__/phase3-audit.test.ts` — audits teams 2,3,4,7.
10. verify-B (report + assertions) — audits teams 5,6 (TUI) + 1 (gui) + 8; ensures
    default `cargo check` stays green and no fabricated screenshots/metrics.

Central integration after: extend `contract.ts` for any new Command/AppEvent kinds,
wire palette/cert/vtph/head-to-head into renderer + sidecar, panes/history into the
TUI, add npm scripts. Then full suite + `cargo check` + smoke tests, then report.

## Phase 3 — STATUS (audited)
All 8 builder teams + 2 adversarial verifiers landed. Full suite **2341 pass**,
`tsc -p tsconfig.lib.json` clean, `cargo test --offline` 9 pass.

DONE + live-wired into the desktop app (shell + renderer controller):
- Command palette overlay (Ctrl/Cmd+K, keyboard-first → real Commands).
- Compare view → real in-memory head-to-head (peak routing speedup 96.75x @ 256).
- Metrics view → async V-TPH$ panel (single source of truth via bench/vtph; honest
  n/a on insufficient data — a +Infinity guard bug the audit found is fixed).
- Trust view → paste-a-cert real ed25519 verify.
- gui Cargo feature (real Tauri window; default build stays headless-green offline).
- Packaging: scripts/package-desktop.mjs (--dry-run honest), CI workflow, INSTALL.md.

Adversarial verdicts: every module REAL (no canned numbers, no fake verifies).
Two real defects were found by the verifiers and fixed centrally (vtph +Infinity
guard; panes.ts em-dash glyph → "(none)").

REMAINING (built + adversarially verified + committed as composable renderers, not
yet consumed by the interactive `hades tui` app.ts state machine):
- tui/panes.ts (split-pane logs + worker drill-in) and tui/history.ts (goal-run
  record + replay) — live-wiring into app.ts keybindings is the next focused step.
