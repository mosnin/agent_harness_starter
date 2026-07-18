//! Hades desktop — real Tauri window shell (feature `gui`).
//!
//! # What this module is
//!
//! When the crate is built with `--features gui`, `main()` (in `main.rs`)
//! delegates to [`run`] here instead of the headless stdio supervisor. [`run`]
//! builds a real [`tauri`] application: it opens the native window described by
//! `tauri.conf.json` (which also points the webview at the built
//! `dist/desktop` frontend via `frontendDist`), spawns the same Node sidecar
//! the headless supervisor spawns, and bridges the IPC contract both halves
//! already speak (`src/desktop/ipc/contract.ts`):
//!
//! - renderer -> sidecar: the webview calls
//!   `invoke("hades_command", { cmd })` (see `src/desktop/ui/bridge.ts`); the
//!   [`hades_command`] handler serializes `cmd` to one newline-delimited JSON
//!   line and writes it to the sidecar's stdin.
//! - sidecar -> renderer: a reader thread turns each AppEvent JSON line on the
//!   sidecar's stdout into a `hades_event` window event
//!   (`window.__TAURI__.listen("hades_event", ...)` on the other side).
//!
//! # What is verified, and what is NOT (be honest)
//!
//! This build environment is headless: no display server, no WebKitGTK /
//! WebView2 / WKWebView, no `cargo tauri` CLI. Therefore:
//!
//!   - The `#[cfg(feature = "gui")]` code below (everything touching `tauri`)
//!     is **not compiled or run here**. Do NOT run `cargo check --features gui`
//!     in this sandbox and expect success — it needs crates.io + the platform
//!     webview libraries. That code is written to be correct by inspection and
//!     is gated entirely behind the feature so it never touches the default
//!     build. It must be compiled/run on a local machine with a display via
//!     `cargo check --features gui` / `cargo tauri dev --features gui`.
//!   - There is no screenshot of a rendered window anywhere in this change,
//!     because no window was rendered here — there is nothing to screenshot
//!     without that local step.
//!
//! What IS proven headless: the pure line-framing helpers at the bottom of this
//! file ([`resolve_sidecar_path`], [`frame_command_line`], [`event_line_payload`])
//! are always compiled (feature on or off) and unit-tested by a plain
//! `cargo test`, because the wire framing is the part most worth pinning down
//! and it needs neither `tauri` nor a display.

// ---------------------------------------------------------------------------
// GUI (feature-gated) — the real Tauri app. Not compiled in the default build.
// ---------------------------------------------------------------------------

/// Window event name carrying a sidecar AppEvent to the renderer. Must match
/// `EVENT_NAME` in `src/desktop/ui/bridge.ts`.
#[cfg(feature = "gui")]
const EVENT_NAME: &str = "hades_event";

/// Shared handles to the currently-running sidecar child process. Held as Tauri
/// managed state so the [`hades_command`] invoke handler can write to the
/// sidecar's stdin, and so the `Child` lives for the app's lifetime rather than
/// being dropped (and orphaned) at the end of `setup`.
#[cfg(feature = "gui")]
#[derive(Default)]
struct SidecarState {
    stdin: std::sync::Mutex<Option<std::process::ChildStdin>>,
    child: std::sync::Mutex<Option<std::process::Child>>,
}

/// Renderer -> sidecar bridge. The webview invokes `"hades_command"` with a
/// single `{ cmd }` argument (a `Command` object per the IPC contract); we
/// re-serialize it to one JSON line and write it to the sidecar's stdin.
///
/// Returns `Err(String)` (surfaced to the renderer's rejected promise) rather
/// than panicking, so a transient sidecar hiccup never tears down the window.
#[cfg(feature = "gui")]
#[tauri::command]
fn hades_command(
    cmd: serde_json::Value,
    state: tauri::State<'_, SidecarState>,
) -> Result<(), String> {
    use std::io::Write;

    let json = serde_json::to_string(&cmd).map_err(|e| format!("encode command: {e}"))?;
    let line = frame_command_line(&json)
        .ok_or_else(|| "refusing to send an empty or multi-line command".to_string())?;

    let mut guard = state
        .stdin
        .lock()
        .map_err(|_| "sidecar stdin lock poisoned".to_string())?;
    let stdin = guard
        .as_mut()
        .ok_or_else(|| "sidecar is not running".to_string())?;

    stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("write to sidecar stdin: {e}"))?;
    stdin
        .flush()
        .map_err(|e| format!("flush sidecar stdin: {e}"))?;
    Ok(())
}

/// Build and run the Tauri application. Never returns under normal operation
/// (Tauri owns the event loop until the window closes).
///
/// The webview source, window geometry, CSP, and bundle config all come from
/// `tauri.conf.json` via `generate_context!()` — this function only wires the
/// sidecar process and the two-way IPC bridge on top of it.
#[cfg(feature = "gui")]
pub fn run() {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use tauri::{Emitter, Manager};

    tauri::Builder::default()
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![hades_command])
        .setup(|app| {
            let sidecar_path = resolve_sidecar_path(std::env::var("HADES_SIDECAR").ok());
            crate::log(&format!("gui: launching sidecar: node {sidecar_path}"));

            let mut child = Command::new("node")
                .arg(&sidecar_path)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // Inherit stderr so sidecar crash logs surface wherever the app
                // was launched from — same choice as the headless supervisor.
                .stderr(Stdio::inherit())
                .spawn()?;

            let child_stdin = child
                .stdin
                .take()
                .expect("child spawned with Stdio::piped() stdin");
            let child_stdout = child
                .stdout
                .take()
                .expect("child spawned with Stdio::piped() stdout");

            // Hand stdin + the Child to managed state: the invoke handler writes
            // Command lines through the stdin; keeping the Child parked here (not
            // dropped) means the process is owned for the app's whole lifetime.
            {
                let state = app.state::<SidecarState>();
                *state
                    .stdin
                    .lock()
                    .map_err(|_| "sidecar stdin lock poisoned")? = Some(child_stdin);
                *state
                    .child
                    .lock()
                    .map_err(|_| "sidecar child lock poisoned")? = Some(child);
            }

            // Reader thread: sidecar stdout (newline-delimited AppEvent JSON)
            // -> `hades_event` window events. Blank lines are skipped;
            // malformed lines are dropped with a log rather than crashing.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(child_stdout);
                for line in reader.lines() {
                    let line = match line {
                        Ok(l) => l,
                        Err(err) => {
                            crate::log(&format!("gui: sidecar stdout read error: {err}"));
                            break;
                        }
                    };
                    let Some(payload) = event_line_payload(&line) else {
                        continue;
                    };
                    match serde_json::from_str::<serde_json::Value>(payload) {
                        Ok(value) => {
                            if let Err(err) = handle.emit(EVENT_NAME, value) {
                                crate::log(&format!("gui: failed to emit {EVENT_NAME}: {err}"));
                            }
                        }
                        Err(err) => {
                            crate::log(&format!("gui: dropping malformed sidecar line: {err}"));
                        }
                    }
                }
                crate::log("gui: sidecar stdout closed; event stream ended");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Hades Tauri application");
}

// ---------------------------------------------------------------------------
// Pure line-framing helpers — ALWAYS compiled (feature on or off) and unit
// tested headless by `cargo test`. std-only, no `tauri`, no I/O.
// ---------------------------------------------------------------------------

/// Resolve the sidecar entry path: the `HADES_SIDECAR` override if it is set to
/// a non-blank value, otherwise the crate default (`DEFAULT_SIDECAR_PATH`,
/// shared with the headless supervisor in `main.rs`). The override is passed in
/// rather than read here so the resolution is pure and testable.
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
fn resolve_sidecar_path(env_override: Option<String>) -> String {
    match env_override {
        Some(p) if !p.trim().is_empty() => p,
        _ => crate::DEFAULT_SIDECAR_PATH.to_string(),
    }
}

/// Frame a single serialized Command as one newline-delimited line for the
/// sidecar's stdin. Returns `None` for a blank payload, or one that already
/// contains a newline or carriage return (which would split into — or corrupt —
/// multiple lines and break the line-delimited protocol). `serde_json` output
/// never contains raw newlines, so in practice this only trims and appends
/// `"\n"`; the rejection path is defensive.
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
fn frame_command_line(json: &str) -> Option<String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed.contains('\n') || trimmed.contains('\r') {
        return None;
    }
    Some(format!("{trimmed}\n"))
}

/// Normalize one line of sidecar stdout into a JSON payload ready to parse, or
/// `None` if the line is blank (spacing / keep-alive) and should be skipped.
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
fn event_line_payload(line: &str) -> Option<&str> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_sidecar_path_prefers_non_blank_override() {
        assert_eq!(
            resolve_sidecar_path(Some("/opt/hades/sidecar.js".to_string())),
            "/opt/hades/sidecar.js"
        );
    }

    #[test]
    fn resolve_sidecar_path_falls_back_on_none_or_blank() {
        assert_eq!(resolve_sidecar_path(None), crate::DEFAULT_SIDECAR_PATH);
        assert_eq!(
            resolve_sidecar_path(Some("   ".to_string())),
            crate::DEFAULT_SIDECAR_PATH
        );
    }

    #[test]
    fn frame_command_line_appends_single_newline() {
        assert_eq!(
            frame_command_line(r#"{"kind":"runtime.stop"}"#).as_deref(),
            Some("{\"kind\":\"runtime.stop\"}\n")
        );
    }

    #[test]
    fn frame_command_line_trims_surrounding_whitespace_before_framing() {
        assert_eq!(
            frame_command_line("  {\"kind\":\"pool.scale\",\"size\":3}  ").as_deref(),
            Some("{\"kind\":\"pool.scale\",\"size\":3}\n")
        );
    }

    #[test]
    fn frame_command_line_rejects_blank_and_multiline_payloads() {
        assert_eq!(frame_command_line(""), None);
        assert_eq!(frame_command_line("   "), None);
        assert_eq!(frame_command_line("{}\n{}"), None);
        assert_eq!(frame_command_line("{}\r{}"), None);
    }

    #[test]
    fn event_line_payload_skips_blank_keeps_content_trimmed() {
        assert_eq!(event_line_payload(""), None);
        assert_eq!(event_line_payload("   \t "), None);
        assert_eq!(
            event_line_payload("  {\"kind\":\"log\",\"line\":\"hi\",\"at\":1}  "),
            Some("{\"kind\":\"log\",\"line\":\"hi\",\"at\":1}")
        );
    }
}
