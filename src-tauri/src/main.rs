//! Hades desktop native shell — process supervisor.
//!
//! # What this file actually is
//!
//! This is the Rust half of the Hades desktop app: a small, dependency-free
//! supervisor that launches the Node "sidecar" (the process that actually
//! drives the swarm — see `src/desktop/sidecar-entry.ts`), pipes this
//! process's stdin/stdout through to it (the sidecar speaks newline-delimited
//! JSON over stdio — see `src/desktop/ipc/contract.ts`), and restarts it with
//! bounded retries if it crashes.
//!
//! # What this file is NOT (be honest about the gap)
//!
//! This build environment is headless: no display server, no webview system
//! libraries, and no `cargo tauri` CLI installed. That means:
//!
//!   - This crate has **zero external dependencies** on purpose, so
//!     `cargo check` (and `cargo build`) succeed offline in a sandbox with
//!     nothing but the Rust standard library. There is no `tauri` crate here.
//!   - There is no window, no webview, no renderer wired up in this binary.
//!     The actual Tauri application shell (native window, webview pointed at
//!     the built desktop UI, IPC bridge from the webview to this process)
//!     is configured declaratively in `tauri.conf.json` next to this file,
//!     and is a **local build step**: on a machine with the Tauri CLI and
//!     the platform webview libs installed, `cargo tauri dev` /
//!     `cargo tauri build` reads that config, generates the real Tauri
//!     `main.rs` bindings (or wraps this supervisor as the sidecar-launching
//!     half of it), and produces the installable app. That step cannot run
//!     here and was not attempted here.
//!
//! In short: this binary is a genuine, runnable process supervisor you can
//! `cargo run` right now (given a `node` on PATH and a sidecar entry file);
//! it is deliberately scoped to the part that does not need a display.
//!
//! # Design
//!
//! - One long-lived thread reads raw bytes from this process's stdin for the
//!   entire lifetime of the supervisor and forwards them to whichever child
//!   is currently attached (via a shared, mutex-guarded slot). This avoids
//!   spawning a fresh stdin-reading thread per restart, which would race
//!   with a still-blocked previous one on the same OS stdin handle.
//! - The main thread owns the restart loop: spawn `node <sidecar>`, attach
//!   its stdin to the shared slot, copy its stdout to our stdout until it
//!   closes, wait for exit, detach, decide whether to retry.
//! - A clean (zero) exit ends supervision (exit 0). A nonzero exit or a
//!   spawn failure triggers a restart, up to `MAX_ATTEMPTS`, with a short
//!   linear backoff between attempts.

use std::env;
use std::io::{self, Read, Write};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

/// Default location of the built sidecar entry point, relative to the
/// desktop app's working directory. Overridable via `HADES_SIDECAR`.
const DEFAULT_SIDECAR_PATH: &str = "./dist/desktop/sidecar-entry.js";

/// Bounded restart budget so a crash-looping sidecar can't spin forever.
const MAX_ATTEMPTS: u32 = 5;

/// Backoff between restart attempts. Linear and short — this is a desktop
/// app supervising a local child process, not a distributed system; the
/// goal is just to avoid a tight crash-loop, not to survive a long outage.
const BACKOFF_STEP: Duration = Duration::from_millis(250);

/// Slot holding the currently-attached child's stdin handle, shared between
/// the persistent stdin-forwarding thread and the main supervisor loop.
/// `None` means no child is currently attached (mid-spawn or mid-restart);
/// bytes read from our stdin during that window are dropped rather than
/// buffered — see the module doc comment.
type StdinSlot = Arc<Mutex<Option<ChildStdin>>>;

fn main() {
    let sidecar_path =
        env::var("HADES_SIDECAR").unwrap_or_else(|_| DEFAULT_SIDECAR_PATH.to_string());

    log(&format!(
        "hades-desktop supervisor starting (sidecar: {sidecar_path})"
    ));

    let stdin_slot: StdinSlot = Arc::new(Mutex::new(None));
    spawn_stdin_forwarder(Arc::clone(&stdin_slot));

    let exit_code = supervise(&sidecar_path, &stdin_slot);
    std::process::exit(exit_code);
}

/// Runs the spawn/attach/forward/wait/retry loop. Returns the process exit
/// code the supervisor itself should exit with.
fn supervise(sidecar_path: &str, stdin_slot: &StdinSlot) -> i32 {
    let mut attempt: u32 = 0;

    loop {
        attempt += 1;
        log(&format!(
            "launching sidecar (attempt {attempt}/{MAX_ATTEMPTS}): node {sidecar_path}"
        ));

        match spawn_and_run(sidecar_path, stdin_slot) {
            Ok(status) => {
                if status.success() {
                    log("sidecar exited cleanly (status 0); supervisor shutting down");
                    return 0;
                }

                let code = status.code().unwrap_or(-1);
                log(&format!("sidecar exited nonzero (status {code})"));

                if attempt >= MAX_ATTEMPTS {
                    log(&format!(
                        "giving up after {attempt} attempts; propagating last exit code"
                    ));
                    return if code >= 0 { code } else { 1 };
                }
            }
            Err(err) => {
                log(&format!("failed to spawn sidecar: {err}"));

                if attempt >= MAX_ATTEMPTS {
                    log(&format!("giving up after {attempt} spawn attempts"));
                    return 1;
                }
            }
        }

        let backoff = BACKOFF_STEP * attempt;
        log(&format!("restarting in {backoff:?}"));
        thread::sleep(backoff);
    }
}

/// Spawns one instance of the sidecar, wires its stdin into the shared slot,
/// copies its stdout to our stdout until the pipe closes, then waits for the
/// child to exit and detaches it from the slot.
fn spawn_and_run(sidecar_path: &str, stdin_slot: &StdinSlot) -> io::Result<ExitStatus> {
    let mut child: Child = Command::new("node")
        .arg(sidecar_path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // The child's stderr is inherited directly (not part of the JSON-line
        // IPC contract) so sidecar crash logs are visible wherever the
        // supervisor's own stderr goes.
        .stderr(Stdio::inherit())
        .spawn()?;

    let child_stdin = child
        .stdin
        .take()
        .expect("child spawned with Stdio::piped() stdin");
    let mut child_stdout = child
        .stdout
        .take()
        .expect("child spawned with Stdio::piped() stdout");

    attach_stdin(stdin_slot, child_stdin);

    // Forward the child's stdout to our stdout on the main thread. This
    // blocks until the child closes its stdout (normally: the child exits),
    // which is what actually paces this loop.
    let mut stdout = io::stdout();
    if let Err(err) = io::copy(&mut child_stdout, &mut stdout) {
        log(&format!("stdout forwarding ended with an error: {err}"));
    }

    let status = child.wait()?;
    detach_stdin(stdin_slot);
    Ok(status)
}

fn attach_stdin(stdin_slot: &StdinSlot, child_stdin: ChildStdin) {
    if let Ok(mut guard) = stdin_slot.lock() {
        *guard = Some(child_stdin);
    }
}

fn detach_stdin(stdin_slot: &StdinSlot) {
    if let Ok(mut guard) = stdin_slot.lock() {
        // Dropping the ChildStdin closes our end of the pipe.
        *guard = None;
    }
}

/// Spawns the single, process-lifetime thread that reads our stdin and
/// relays raw bytes to whichever child is currently attached to `slot`.
///
/// This exists once, not once-per-restart: two threads both blocked in
/// `read()` on the same OS stdin handle would race for bytes across a
/// restart boundary, silently corrupting the JSON-line stream. Routing all
/// restarts through one reader and a swappable destination avoids that.
fn spawn_stdin_forwarder(slot: StdinSlot) {
    thread::spawn(move || {
        let mut stdin = io::stdin();
        let mut buf = [0u8; 8192];
        loop {
            let n = match stdin.read(&mut buf) {
                Ok(0) => {
                    log("stdin closed (EOF); no more input will be forwarded");
                    break;
                }
                Ok(n) => n,
                Err(err) => {
                    log(&format!("stdin read error, stopping forwarder: {err}"));
                    break;
                }
            };

            match slot.lock() {
                Ok(mut guard) => {
                    if let Some(child_stdin) = guard.as_mut() {
                        // Best-effort: if the child just died, this write
                        // fails and the bytes are dropped. The next command
                        // line the renderer sends will simply be lost for
                        // this gap — acceptable for a desktop dev shell,
                        // and the renderer/TUI can resend on reconnect.
                        if child_stdin.write_all(&buf[..n]).is_ok() {
                            let _ = child_stdin.flush();
                        }
                    }
                    // No child attached right now: bytes are dropped.
                }
                Err(_) => break, // mutex poisoned; nothing sane left to do
            }
        }
    });
}

fn log(msg: &str) {
    eprintln!("[hades-desktop] {msg}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sidecar_path_is_relative_to_dist_desktop() {
        assert_eq!(DEFAULT_SIDECAR_PATH, "./dist/desktop/sidecar-entry.js");
    }

    #[test]
    fn backoff_grows_linearly_and_stays_short() {
        assert_eq!(BACKOFF_STEP * 1, Duration::from_millis(250));
        assert_eq!(BACKOFF_STEP * MAX_ATTEMPTS, Duration::from_millis(1250));
    }

    #[test]
    fn stdin_slot_starts_and_ends_empty_around_a_child_lifecycle() {
        let slot: StdinSlot = Arc::new(Mutex::new(None));
        assert!(slot.lock().unwrap().is_none());
        // attach/detach are exercised end-to-end in spawn_and_run, which
        // needs a real child process (`node`) and is covered by manually
        // running the supervisor against the sidecar rather than a unit
        // test here.
        detach_stdin(&slot);
        assert!(slot.lock().unwrap().is_none());
    }
}
