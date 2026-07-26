/**
 * Hades desktop renderer bridge — the seam between the Tauri webview
 * frontend and the local sidecar (`../core/sidecar.ts`).
 *
 * The renderer (the shell/views under `./`) never talks to a `Sidecar` or to
 * `window.__TAURI__` directly. It talks to a `Bridge`: a tiny, uniform
 * surface for sending `Command`s and subscribing to `AppEvent`s, regardless
 * of what's on the other side of the seam. Two implementations satisfy it:
 *
 * - {@link tauriBridge} — the production bridge. Runs inside the real Tauri
 *   webview and forwards everything to the Rust supervisor, which owns the
 *   actual sidecar child process (see `src/desktop/sidecar-entry.ts`).
 * - {@link devBridge} — runs a `Sidecar` in-process, in the same JS realm as
 *   the renderer. No Tauri, no window, no child process — which is exactly
 *   what makes the renderer runnable in tests and in `desktop:dev` without a
 *   display or a native shell.
 */

import { isAppEvent, type AppEvent, type Command } from "../ipc/contract";
import { Sidecar, type SwarmFactory } from "../core/sidecar";

// ---------------------------------------------------------------------------
// Bridge contract
// ---------------------------------------------------------------------------

export interface Bridge {
  /** Send a command to whatever is driving the swarm. Never throws. */
  send(cmd: Command): void;
  /** Register a listener for every `AppEvent`. Returns an unsubscribe function. */
  onEvent(cb: (e: AppEvent) => void): () => void;
  /** Wire up the bridge (e.g. start listening for events). Idempotent-ish; call once before use. */
  start(): Promise<void>;
  /** Tear the bridge down. */
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared listener fan-out
// ---------------------------------------------------------------------------

/**
 * A minimal pub/sub of `AppEvent` listeners, shared by both bridge
 * implementations so "register a callback, get back an unsubscribe function"
 * behaves identically everywhere.
 */
function createEventHub(): {
  dispatch: (e: AppEvent) => void;
  subscribe: (cb: (e: AppEvent) => void) => () => void;
  clear: () => void;
} {
  const listeners = new Set<(e: AppEvent) => void>();
  return {
    dispatch(e: AppEvent) {
      for (const cb of listeners) {
        try {
          cb(e);
        } catch {
          /* a bad listener must never break the bridge or other listeners */
        }
      }
    },
    subscribe(cb: (e: AppEvent) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    clear() {
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// devBridge — in-process sidecar, no Tauri, no window.
// ---------------------------------------------------------------------------

export interface DevBridgeOptions {
  /** Defaults to the real engine factory built into `Sidecar` itself. */
  factory?: SwarmFactory;
}

/**
 * Dev/browserless bridge: runs a `Sidecar` in-process so the renderer works
 * in tests and in `desktop:dev` — no Tauri, no window, no native shell, no
 * display required. `send` drives the sidecar directly; the sidecar's own
 * `emit` fans out to whatever callbacks are registered via `onEvent`.
 */
export function devBridge(opts: DevBridgeOptions = {}): Bridge {
  const hub = createEventHub();

  const sidecar = new Sidecar({
    factory: opts.factory,
    emit: (e: AppEvent) => hub.dispatch(e),
  });

  return {
    send(cmd: Command): void {
      try {
        void sidecar.handle(cmd);
      } catch {
        /* Sidecar.handle never throws synchronously, but guard anyway. */
      }
    },
    onEvent(cb: (e: AppEvent) => void): () => void {
      return hub.subscribe(cb);
    },
    async start(): Promise<void> {
      // No-op: the in-process sidecar needs no wiring beyond construction.
    },
    async stop(): Promise<void> {
      await sidecar.close();
      hub.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// tauriBridge — production bridge, talks to the Rust supervisor.
// ---------------------------------------------------------------------------

/** The slice of the Tauri JS API this bridge needs. Injectable for tests. */
export interface TauriApi {
  invoke: (cmd: string, args: unknown) => Promise<unknown>;
  listen: (event: string, cb: (ev: { payload: unknown }) => void) => Promise<() => void>;
}

const COMMAND_INVOKE = "hades_command";
const EVENT_NAME = "hades_event";

/**
 * Reads the injected Tauri API, falling back to `globalThis.__TAURI__`. Only
 * called lazily (inside `send`/`start`), never at module load or at
 * `tauriBridge()` construction time, so a renderer can build a `tauriBridge`
 * before Tauri's `__TAURI__` global has been injected into the page.
 */
function resolveTauri(injected: TauriApi | undefined): TauriApi {
  if (injected) return injected;
  const global = globalThis as unknown as { __TAURI__?: TauriApi };
  if (!global.__TAURI__) {
    throw new Error(
      "tauriBridge: window.__TAURI__ is not available — this bridge must run inside the Tauri webview (use devBridge() outside of it)"
    );
  }
  return global.__TAURI__;
}

/**
 * Production bridge: talks to the Tauri backend via
 * `window.__TAURI__.invoke("hades_command", { cmd })` and
 * `window.__TAURI__.listen("hades_event", ...)`. The Rust supervisor on the
 * other end owns the real sidecar child process and the wire format defined
 * in `../ipc/contract.ts`.
 */
export function tauriBridge(tauri?: TauriApi): Bridge {
  const hub = createEventHub();
  let unlisten: (() => void) | undefined;

  return {
    send(cmd: Command): void {
      try {
        const api = resolveTauri(tauri);
        void api.invoke(COMMAND_INVOKE, { cmd }).catch(() => {
          /* transport failures surface as missing events, not exceptions */
        });
      } catch {
        /* never throw synchronously from send — e.g. __TAURI__ missing */
      }
    },
    onEvent(cb: (e: AppEvent) => void): () => void {
      return hub.subscribe(cb);
    },
    async start(): Promise<void> {
      const api = resolveTauri(tauri);
      unlisten = await api.listen(EVENT_NAME, (ev: { payload: unknown }) => {
        // The Rust supervisor already emits well-formed `AppEvent`s, but
        // never trust a cross-process payload blindly — a malformed one is
        // silently dropped rather than corrupting renderer state.
        if (isAppEvent(ev.payload)) hub.dispatch(ev.payload);
      });
    },
    async stop(): Promise<void> {
      unlisten?.();
      unlisten = undefined;
      hub.clear();
    },
  };
}
