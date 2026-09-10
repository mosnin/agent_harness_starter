# CLAUDE.md — read this before doing anything

## What this project is (do not misread this)

This is an **open-source, lightweight AI agent harness** built in the spirit of
**Nous Research's Hermes agent** — and meant to beat it. Hermes is the reference
blueprint; the whole repo it ships was provided as the model. We build everything
Hermes has, better, plus the STYX verification thesis (`docs/STYX_ARCHITECTURE.md`).

It is an **agent you run**, not a website. Its home is the terminal and the
desktop. Think Hermes / OpenClaw / Claude Code, not a SaaS dashboard.

## The product's real surfaces (this is what "the UI" means)

When the user says "the UI", "the front end", "take the UI to the next level",
"the design", or anything similar, they mean these — in this order:

1. **CLI** — the `hades` / `hermes-swarm` command line. Runs on a $5 VPS.
2. **TUI** — the terminal interface (`src/swarm-runtime/tui/`, and the REPL).
3. **Native desktop app** — a real installable app (Tauri / Electron class),
   the way Hermes ships a macOS / Linux / Windows desktop app.

## HARD RULES — violating these is the failure mode the user is sick of

- **NEVER build a web/HTML/Next.js dashboard or a browser SPA as "the UI."**
  A browser app is not this product. Do not "redesign the UI" by touching
  `src/app/**` or serving an HTML page and calling it the front end.
- The `src/app/**` Next.js directory is **leftover starter-kit scaffolding**,
  NOT the product. Do not invest design effort there. Do not treat it as the flagship.
- **Do not produce HTML/CSS "premium redesigns," landing pages, or web artifacts**
  unless the user explicitly and unambiguously asks for a web page by name.
- "Next level UI / animations / premium design" = the **desktop app and the TUI**.
  Reach for the desktop app first (that is what Hermes has and we must exceed).
- If you are ever unsure whether a surface belongs to this product, ask ONE
  question before building — do not assume and pour effort into the wrong thing.

## Working norms the user has had to repeat (honor them)

- **No fabricated or simulated numbers presented as real.** Benchmarks run real
  code or are labeled a model. Adversarial verification stays.
- **Do not over-produce.** Match effort to the ask. Sloppy, misdirected volume is
  worse than a small correct thing. When corrected, fix the actual thing, tersely.
- Develop / commit / push only to branch `claude/hermes-swarm-framework-vbhrot`.
  Do not open a PR unless explicitly asked.
- The model identifier `claude-opus-4-8` never appears in commits, code, or docs.

## Where the real work lives

- `src/hades/` — the agent (brain, tools, MCP, skills, STYX verification swarm).
- `src/swarm-runtime/` — the swarm core (manager, workers, verification gate, TUI).
- `docs/STYX_ARCHITECTURE.md`, `.plans/HADES_BEYOND_HERMES.md` — the thesis + roadmap.
