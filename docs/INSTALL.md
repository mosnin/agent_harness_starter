# Installing / building the Hades desktop app

Hades is a native desktop application (a Tauri shell around a Node sidecar and a
webview renderer — see [DESKTOP_APP.md](./DESKTOP_APP.md) for the architecture),
not a website or a hosted dashboard. This document is the honest, end-to-end
recipe for turning the source in this repo into an installer on your own
machine, plus a clear statement of what has and has NOT been built and tested in
this repo's CI environment.

There are two halves to a desktop build:

1. **The JS bundles** (Node sidecar + webview UI) — pure esbuild, run headless,
   verified in this repo's CI.
2. **The native installer** (`cargo tauri build`) — needs a real machine with a
   display and the platform webview libraries. NOT run in this repo's CI; see
   the honesty section at the end.

## Prerequisites

| Requirement | All platforms | macOS | Linux | Windows |
| --- | --- | --- | --- | --- |
| Node.js ≥ 20 | ✅ | | | |
| Rust toolchain (`cargo`) | ✅ | | | |
| Tauri CLI (`cargo install tauri-cli --locked`) | ✅ | | | |
| Platform webview | | WKWebView (system) | WebKitGTK 4.1 | WebView2 (system on Win 10/11) |
| Extra system libs | | Xcode command-line tools | see below | Visual Studio C++ Build Tools |

### Linux system libraries

The webview and the `.deb` / `.AppImage` bundlers need these dev packages
(Debian/Ubuntu names; the CI workflow installs the same set):

```bash
sudo apt-get update
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev patchelf build-essential curl wget file
```

### The `gui` Cargo feature (read this)

The build command is `cargo tauri build --features gui`. That `gui` feature
(the real `tauri` dependency + window/webview bootstrap on top of the
dependency-free `src-tauri/src/main.rs` supervisor) is being added to
`src-tauri/Cargo.toml` in parallel. Until it lands, `cargo tauri build
--features gui` fails with an unknown-feature error — the JS bundle halves still
succeed. This is the same caveat documented in
[DESKTOP_APP.md](./DESKTOP_APP.md#desktop-dev-webview-needs-a-display).

## Build flow

### Step 1 — bundle the JS halves (headless-safe)

```bash
npm install
npm run desktop:build
```

`npm run desktop:build` runs both bundlers:

- `desktop:build:sidecar` → `dist/desktop/sidecar-entry.js` (the Node sidecar
  the native shell spawns)
- `desktop:build:ui` → `dist/desktop/{main.js, main.css, index.html}` (the
  webview frontend)

Both are plain esbuild and run anywhere Node runs — no display required.

### Step 2 — build the native installer (needs a display + toolchain)

```bash
cd src-tauri && cargo tauri build --features gui
```

This reads `src-tauri/tauri.conf.json`, opens a webview, and emits the
platform installers.

### One-shot orchestrator: `scripts/package-desktop.mjs`

`scripts/package-desktop.mjs` wraps both steps. It bundles the two JS halves,
detects whether the native prerequisites (`cargo`, `cargo-tauri`, a display)
are present, and either runs `cargo tauri build --features gui` or, when they're
absent, prints exactly what it *would* run without pretending it ran:

```bash
# Auto: full build where the toolchain + display exist, dry-run otherwise
node scripts/package-desktop.mjs

# Force the honest dry-run (bundles the JS halves, describes the Tauri step)
node scripts/package-desktop.mjs --dry-run

# Force the full native build (fails loudly if prerequisites are missing)
node scripts/package-desktop.mjs --full
```

It exits non-zero only when a step it actually attempted really failed. A
dry-run that skips the native step is a success.

## Where the installers land

`cargo tauri build` writes to `src-tauri/target/release/bundle/`:

| Platform | Targets (`bundle.targets` in `tauri.conf.json`) | Path |
| --- | --- | --- |
| macOS | `dmg`, `app` | `bundle/dmg/*.dmg`, `bundle/macos/*.app` |
| Linux | `deb`, `appimage` | `bundle/deb/*.deb`, `bundle/appimage/*.AppImage` |
| Windows | `msi`, `nsis` | `bundle/msi/*.msi`, `bundle/nsis/*.exe` |

## Continuous integration

`.github/workflows/desktop-build.yml` builds all three platforms' installers on
GitHub-hosted runners (`macos-latest`, `ubuntu-latest`, `windows-latest`). It
installs Rust, the Linux webview libraries, and the Tauri CLI; runs
`npm run desktop:build`; runs `cargo tauri build --features gui`; and uploads
the installer artifacts. It is gated to **manual dispatch** (`workflow_dispatch`)
and **version tags** (`v*`) so it never runs on ordinary pushes or PRs.

## What has NOT been built or tested in this repo's CI environment

Being explicit, because it matters:

- **No installer (`.dmg`, `.deb`, `.AppImage`, `.msi`, `.nsis`) has been
  produced in this repo's headless CI sandbox.** `cargo tauri build` needs a
  display + the platform webview libraries + the `cargo tauri` CLI, none of
  which exist here. No installer artifact is committed anywhere in this repo.
- **`cargo tauri build --features gui` has not been run here**, and — per the
  `gui` feature caveat above — cannot succeed until that Cargo feature lands,
  even on a fully equipped machine.
- **No native window has been opened or screenshotted.** There is nothing to
  screenshot without the native build step.

What *is* proven headless (in this repo's CI and locally):

- The two JS bundle halves (`npm run desktop:build`) build and are unit-tested.
- `scripts/package-desktop.mjs`'s orchestration — prerequisite detection, the
  dry-run plan, and the exact `cd src-tauri && cargo tauri build --features gui`
  command it emits — is unit-tested
  (`src/desktop/__tests__/package-desktop.test.ts`), without ever invoking
  cargo or opening a display.
- The Rust supervisor (`src-tauri/src/main.rs`) compiles with `cargo check` and
  passes its own unit tests (no `tauri` dependency needed for that half).
- `.github/workflows/desktop-build.yml` is the correct recipe for producing the
  installers on real runners; running it (dispatch or tag) is what actually
  builds them.
