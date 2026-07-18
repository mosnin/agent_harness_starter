//! Build script for the Hades desktop crate.
//!
//! # Default build (feature `gui` OFF) — what runs in this headless env
//!
//! A no-op. The default build is the std-only process supervisor
//! (`src/main.rs`) and pulls no build dependencies at all; this `main`
//! compiles to nothing. `cargo check` / `cargo test` therefore stay green
//! offline, exactly as before this file existed.
//!
//! # `--features gui` build — the real Tauri app, LOCAL/display machine only
//!
//! Runs `tauri_build::build()`, which reads `tauri.conf.json` and generates the
//! Tauri context + capability/permission scaffolding that
//! `tauri::generate_context!()` (in `src/gui.rs`) consumes at compile time.
//! `tauri-build` is an OPTIONAL build-dependency enabled only by the `gui`
//! feature (see `Cargo.toml`), so it is neither downloaded nor compiled unless
//! the feature is on. This branch is NOT exercised in the headless build
//! environment (no Tauri toolchain / webview libs); it is verified only on a
//! machine with a display via `cargo check --features gui` / `cargo tauri build`.
fn main() {
    #[cfg(feature = "gui")]
    tauri_build::build();
}
