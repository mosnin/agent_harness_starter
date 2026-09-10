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
// ---------------------------------------------------------------------------
// GUI (feature-gated) — the real Tauri app. Not compiled in the default build.
// ---------------------------------------------------------------------------

#[path = "request_capacity.rs"]
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
mod request_capacity;

/// WebKit caches these defaults when its native text checker initializes.
/// Set them before constructing Tauri/WKWebView. The volatile argument domain
/// is in-memory and app-local: it changes neither macOS global preferences nor
/// persisted per-app settings. Preserve unrelated launch overrides.
/// Source: WebKit/Source/WebKit/UIProcess/mac/TextCheckerMac.mm.
#[cfg(all(feature = "gui", target_os = "macos"))]
const LITERAL_INPUT_DEFAULTS: [&str; 6] = [
    "WebAutomaticDashSubstitutionEnabled",
    "WebAutomaticQuoteSubstitutionEnabled",
    "WebAutomaticTextReplacementEnabled",
    "WebAutomaticSpellingCorrectionEnabled",
    "WebContinuousSpellCheckingEnabled",
    "WebGrammarCheckingEnabled",
];

#[cfg(all(feature = "gui", target_os = "macos"))]
fn configure_literal_coding_input() {
    use objc2_foundation::{NSMutableDictionary, NSNumber, NSString, NSUserDefaults, NSArgumentDomain};
    let defaults = NSUserDefaults::standardUserDefaults();
    // SAFETY: Foundation owns the immutable domain-name constant for the
    // process lifetime; this typed dictionary retains property-list values.
    unsafe {
        let domain = NSArgumentDomain;
        let overrides = NSMutableDictionary::new();
        overrides.setDictionary(&defaults.volatileDomainForName(domain));
        let disabled = NSNumber::new_bool(false);
        for key in LITERAL_INPUT_DEFAULTS {
            overrides.insert(&*NSString::from_str(key), &*disabled);
        }
        defaults.setVolatileDomain_forName(&overrides, domain);
    }
}

/// Window event name carrying a sidecar AppEvent to the renderer. Must match
/// `EVENT_NAME` in `src/desktop/ui/bridge.ts`.
#[cfg(feature = "gui")]
const EVENT_NAME: &str = "hades_event";

#[cfg(all(feature = "gui", unix))]
fn kill_owned_group(group: u32) {
    let _ = std::process::Command::new("/bin/kill")
        .args(["-KILL", "--", &format!("-{group}")])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null()).status();
}

/// Shared handles to the currently-running sidecar child process. Held as Tauri
/// managed state so the [`hades_command`] invoke handler can write to the
/// sidecar's stdin, and so the `Child` lives for the app's lifetime rather than
/// being dropped (and orphaned) at the end of `setup`.
#[cfg(feature = "gui")]
#[derive(Default)]
struct SidecarState {
    keychain_busy: std::sync::atomic::AtomicBool,
    stdin: std::sync::Mutex<Option<std::process::ChildStdin>>,
    child: std::sync::Mutex<Option<std::process::Child>>,
    pending: std::sync::Mutex<
        request_capacity::PendingRequests<std::sync::mpsc::Sender<serde_json::Value>>,
    >,
}

/// Renderer -> sidecar bridge. The webview invokes `"hades_command"` with a
/// single `{ cmd }` argument (a `Command` object per the IPC contract); we
/// re-serialize it to one JSON line and write it to the sidecar's stdin.
///
/// Returns `Err(String)` (surfaced to the renderer's rejected promise) rather
/// than panicking, so a transient sidecar hiccup never tears down the window.
#[cfg(feature = "gui")]
fn send_sidecar(
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

#[cfg(feature = "gui")]
async fn request_sidecar(
    mut cmd: serde_json::Value,
    state: tauri::State<'_, SidecarState>,
) -> Result<serde_json::Value, String> {
    let id = cmd
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("Missing request id")?
        .to_string();
    let method = cmd.get("method").and_then(|v| v.as_str()).unwrap_or("");
    let operation = cmd.get("args").and_then(|args| args.get("operation")).and_then(|v| v.as_str());
    let (tx, rx) = std::sync::mpsc::channel();
    let ticket = {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| "Request lock unavailable")?;
        pending
            .admit(id.clone(), method, operation, tx)
            .map_err(|error| error.to_string())?
    };
    cmd["id"] = serde_json::Value::String(ticket.wire_id());
    let write_result = send_sidecar(cmd, state.clone());
    if let Err(error) = write_result {
        state
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove_if(&id, ticket);
        return Err(error);
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(65))
    })
    .await;
    // Always release capacity, including a blocking task join failure. A response
    // may already have consumed this entry; never remove a newer reused ID.
    state
        .pending
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove_if(&id, ticket);
    let result = result.map_err(|error| {
        format!("The local backend response wait failed; outcome is unknown: {error}")
    })?;
    result.map_err(|_| "The local backend did not respond".into())
}

// The renderer cannot request native credential replies or reserve native IDs.
#[cfg_attr(not(feature = "gui"), allow(dead_code))]
fn renderer_request_allowed(method: &str, id: &str) -> bool {
    !method.starts_with("native.") && !id.starts_with("native-")
}
#[cfg(feature = "gui")]
fn validate_renderer_request(cmd: &serde_json::Value) -> Result<(), String> {
    if !renderer_request_allowed(cmd.get("method").and_then(|v| v.as_str()).unwrap_or(""), cmd.get("id").and_then(|v| v.as_str()).unwrap_or("")) {
        return Err("This action requires the native credential bridge".into());
    }
    Ok(())
}
#[cfg(feature = "gui")]
#[tauri::command]
fn hades_command(cmd: serde_json::Value, state: tauri::State<'_, SidecarState>) -> Result<(), String> {
    validate_renderer_request(&cmd)?;
    send_sidecar(cmd, state)
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn hades_request(cmd: serde_json::Value, state: tauri::State<'_, SidecarState>) -> Result<serde_json::Value, String> {
    validate_renderer_request(&cmd)?;
    request_sidecar(cmd, state).await
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn hades_team(action: String, args: serde_json::Value, state: tauri::State<'_, SidecarState>) -> Result<bool, String> {
    if !["create", "join", "resume"].contains(&action.as_str()) { return Err("Unknown team connection action".into()); }
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_nanos();
    let response = request_sidecar(serde_json::json!({
        "kind": "desktop.request", "id": format!("native-team-{stamp}"),
        "method": format!("native.team.{action}"), "args": args
    }), state.clone()).await?;
    if let Some(error) = response.get("error").and_then(|v| v.as_str()) { return Err(error.to_string()); }
    let token = response.get("result").and_then(|v| v.get("token")).and_then(|v| v.as_str()).ok_or("Team connection did not return credentials")?;
    if token.is_empty() { return Err("No pending team connection to save".into()); }
    hades_key("team-access".into(), Some(token.to_string()), state).await?;
    Ok(true)
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

    #[cfg(target_os = "macos")]
    configure_literal_coding_input();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        let _ = hades_window(app.clone(), "hud".into(), None);
                    }
                })
                .build(),
        )
        .manage(SidecarState::default())
        .invoke_handler(tauri::generate_handler![
            hades_command,
            hades_request,
            hades_window,
            hades_key,
            hades_team,
            hades_quick_entry
        ])
        .setup(|app| {
            let resources = app.path().resource_dir()?;
            let bundled = resources.join("sidecar-entry.js");
            let sidecar_path = std::env::var("HADES_SIDECAR").unwrap_or_else(|_| {
                if bundled.exists() {
                    bundled.to_string_lossy().into_owned()
                } else {
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                        .join("../dist/desktop/sidecar-entry.js")
                        .to_string_lossy()
                        .into_owned()
                }
            });
            let node = if resources.join("node").exists() {
                resources.join("node")
            } else {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/runtime/node")
            };
            let home = app.path().home_dir()?;
            let data = std::env::var("HADES_DATA_DIR")
                .map(std::path::PathBuf::from)
                .unwrap_or(home.join(".hades"));
            std::fs::create_dir_all(&data)?;
            crate::log(&format!("gui: launching sidecar: node {sidecar_path}"));

            let mut command = Command::new(node);
            #[cfg(unix)]
            {
                use std::os::unix::process::CommandExt;
                command.process_group(0)
                    .env("HADES_NATIVE_PROCESS_GROUP", "1")
                    .env("HADES_NATIVE_PARENT", std::process::id().to_string());
            }
            let mut child = command
                .arg(&sidecar_path)
                .current_dir(&home)
                .env("HADES_DATA_DIR", &data)
                .env("HADES_COMPUTER", if resources.join("hades-computer").exists() {
                    resources.join("hades-computer")
                } else {
                    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist/runtime/hades-computer")
                })
                .env(
                    "HADES_PTY",
                    if resources.join("hades-pty").exists() {
                        resources.join("hades-pty")
                    } else {
                        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                            .join("../dist/runtime/hades-pty")
                    },
                )
                .env(
                    "PATH",
                    format!(
                        "/opt/homebrew/bin:/usr/local/bin:{}",
                        std::env::var("PATH").unwrap_or_default()
                    ),
                )
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                // Inherit stderr so sidecar crash logs surface wherever the app
                // was launched from — same choice as the headless supervisor.
                .stderr(Stdio::from(std::fs::File::create(
                    data.join("desktop-backend.log"),
                )?))
                .spawn()?;

            let child_stdin = child
                .stdin
                .take()
                .expect("child spawned with Stdio::piped() stdin");
            let sidecar_group = child.id();
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
                        Ok(mut value) => {
                            if value.get("kind").and_then(|v| v.as_str())
                                == Some("desktop.response")
                            {
                                if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                                    if id.starts_with(request_capacity::WIRE_ID_PREFIX) {
                                        let state = handle.state::<SidecarState>();
                                        let waiter = state.pending.lock().ok()
                                            .and_then(|mut pending| pending.remove_wire(id));
                                        if let Some((caller_id, sender)) = waiter {
                                            value["id"] = serde_json::Value::String(caller_id);
                                            let _ = sender.send(value);
                                        }
                                        // Unknown/late native wire responses are discarded.
                                        continue;
                                    }
                                    // Other native credential/configuration replies remain private.
                                    if id.starts_with("native-") {
                                        continue;
                                    }
                                }
                                // Plain hades_command responses retain their original IDs
                                // and continue through the renderer event channel.
                            }
                            if let Err(err) = handle.emit(EVENT_NAME, value) {
                                crate::log(&format!("gui: failed to emit {EVENT_NAME}: {err}"));
                            }
                        }
                        Err(err) => {
                            crate::log(&format!("gui: dropping malformed sidecar line: {err}"));
                        }
                    }
                }
                // A closed IPC stream revokes this backend's lifetime even
                // when the window remains open. Release pending RPC waiters.
                handle.state::<SidecarState>().pending.lock().ok().map(|mut p| p.clear());
                #[cfg(unix)]
                kill_owned_group(sidecar_group);
                let _ = handle.emit(
                    EVENT_NAME,
                    serde_json::json!({"kind":"desktop.disconnected"}),
                );
                crate::log("gui: sidecar stdout closed; event stream ended");
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hades")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<SidecarState>();
                state.stdin.lock().ok().and_then(|mut s| s.take());
                if let Ok(mut guard) = state.child.lock() {
                    if let Some(mut child) = guard.take() {
                        let group = child.id();
                        // EOF lets the backend cancel turns and reap its PTY children.
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(2);
                        while matches!(child.try_wait(), Ok(None))
                            && std::time::Instant::now() < deadline
                        {
                            std::thread::sleep(std::time::Duration::from_millis(20));
                        }
                        if matches!(child.try_wait(), Ok(None)) {
                            let _ = child.kill();
                        }
                        let _ = child.wait();
                        // Codex and non-detached tool children can outlive Node.
                        // Only signal the group created for this exact sidecar.
                        #[cfg(unix)]
                        kill_owned_group(group);
                    }
                };
            }
        });
}

#[cfg(feature = "gui")]
#[tauri::command]
fn hades_quick_entry(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if enabled
        && app
            .global_shortcut()
            .is_registered("CommandOrControl+Shift+Space")
    {
        return Ok(());
    }
    if enabled {
        app.global_shortcut()
            .register("CommandOrControl+Shift+Space")
            .map_err(|e| e.to_string())
    } else {
        app.global_shortcut()
            .unregister("CommandOrControl+Shift+Space")
            .map_err(|e| e.to_string())
    }
}

#[cfg(feature = "gui")]
#[tauri::command]
fn hades_window(
    app: tauri::AppHandle,
    action: String,
    session: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;
    let label = if action == "hud" {
        "hud".to_string()
    } else {
        format!(
            "chat-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        )
    };
    if let Some(window) = app.get_webview_window(&label) {
        window.close().map_err(|e| e.to_string())?;
        return Ok(());
    }
    let session = session
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect::<String>();
    let query = format!(
        "?session={session}{}",
        if action == "hud" { "&hud=1" } else { "" }
    );
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App(format!("index.html{query}").into()),
    )
    .title("Hades")
    .inner_size(960.0, 700.0)
    .min_inner_size(500.0, 400.0);
    if action == "hud" {
        builder = builder.inner_size(640.0, 400.0).always_on_top(true);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}
#[cfg(feature = "gui")]
#[tauri::command]
async fn hades_key(
    account: String,
    value: Option<String>,
    state: tauri::State<'_, SidecarState>,
) -> Result<bool, String> {
    if !account
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_:".contains(c))
        || account.len() > 120
    {
        return Err("Invalid provider account".into());
    }
    #[cfg(target_os = "macos")]
    {
        use std::sync::atomic::Ordering;
        if state.keychain_busy.swap(true, Ordering::SeqCst) {
            return Err("Finish or dismiss the existing macOS Keychain request first".into());
        }
        // Security.framework may wait for a system credential dialog. Never
        // block the AppKit thread or allow an unbounded queue of prompts.
        let result = tauri::async_runtime::spawn_blocking(move || -> Result<(String, String), String> {
        use security_framework::passwords::{
            delete_generic_password, get_generic_password, set_generic_password,
        };
        let service = "ai.hades.desktop";
        if let Some(ref v) = value {
            if v.is_empty() {
                let _ = delete_generic_password(service, &account);
            } else {
                set_generic_password(service, &account, v.as_bytes())
                    .map_err(|e| format!("Keychain: {e}"))?;
            }
        }
        let key = match get_generic_password(service, &account) {
            Ok(bytes) => String::from_utf8(bytes).map_err(|_| "Invalid saved credential encoding".to_string())?,
            Err(error) if error.code() == -25300 => String::new(),
            Err(_) => return Err("macOS did not allow access to the saved credential. Finish the Keychain prompt or reconnect after granting access.".into()),
        };
        Ok((account, key))
        }).await;
        state.keychain_busy.store(false, Ordering::SeqCst);
        let (account, key) = result.map_err(|_| "Keychain worker failed".to_string())??;
        let configured = !key.is_empty();
        send_sidecar(
            serde_json::json!({"kind":"desktop.request","id":"native-key","method":"key.set","args":{"account":account,"key":key}}),
            state,
        )?;
        Ok(configured)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (value, state);
        Err("Keychain is available on macOS only; use environment credentials.".into())
    }
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
#[allow(dead_code)]
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
    fn renderer_cannot_request_credentials_or_hijack_native_responses() {
        assert!(!renderer_request_allowed("native.team.resume", "web-1"));
        assert!(!renderer_request_allowed("boot", "native-team-123"));
        assert!(!renderer_request_allowed("boot", "native-key"));
        assert!(renderer_request_allowed("team.status", "web-1"));
        assert!(renderer_request_allowed("slack.status", "web-2"));
    }

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

#[cfg(all(test, feature = "gui", target_os = "macos"))]
mod literal_input_tests {
    #[test]
    fn disables_native_substitution_in_memory_and_preserves_other_launch_defaults() {
        use objc2_foundation::{NSMutableDictionary, NSNumber, NSString, NSUserDefaults, NSArgumentDomain};
        let defaults = NSUserDefaults::standardUserDefaults();
        unsafe {
            let domain = NSArgumentDomain;
            let original = defaults.volatileDomainForName(domain);
            let test_defaults = NSMutableDictionary::new();
            test_defaults.setDictionary(&original);
            let marker = NSString::from_str("HadesLiteralInputTestMarker");
            test_defaults.insert(&*marker, &*NSNumber::new_bool(true));
            defaults.setVolatileDomain_forName(&test_defaults, domain);
            super::configure_literal_coding_input();
            let preserved = defaults.boolForKey(&marker);
            let all_disabled = super::LITERAL_INPUT_DEFAULTS.iter().all(|key|
                !defaults.boolForKey(&NSString::from_str(key)));
            defaults.setVolatileDomain_forName(&original, domain);
            assert!(preserved);
            assert!(all_disabled);
        }
    }
}
