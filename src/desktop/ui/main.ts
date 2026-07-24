/**
 * Hades desktop webview entry point — bundled by scripts/build-desktop.mjs
 * into dist/desktop/main.js and loaded by src/desktop/ui/index.html inside
 * the Tauri native window.
 *
 * Keep this file tiny: pick a `Bridge` (the production `tauriBridge` when
 * running inside the real Tauri webview, or the in-process `devBridge`
 * otherwise) and hand the DOM root + bridge to `mountApp`. All real logic
 * (state, rendering, event wiring) lives in ./renderer and its dependents.
 *
 * This is not a web app — it is the frontend half of a native desktop app.
 * There is no server behind this bundle; the other end of the bridge is a
 * local sidecar process (see ../core/sidecar.ts / ../sidecar-entry.ts).
 */

// App CSS — theme tokens plus every view's stylesheet. Pulled in here purely
// so esbuild's `css` loader bundles them into dist/desktop/main.css; none of
// these imports are used as JS values.
import "./tokens.css";
import "./shell.css";
import "./run-view.css";
import "./trust-view.css";
import "./skills-view.css";
import "./fleet-view.css";
import "./fleet-provision-view.css";
import "./fleet-conflicts-view.css";

import { mountApp } from "./renderer";
import { tauriBridge, devBridge } from "./bridge";

function hasTauri(): boolean {
  return typeof (globalThis as { __TAURI__?: unknown }).__TAURI__ !== "undefined";
}

function boot(): void {
  const root = document.getElementById("root");
  if (!root) {
    // No #root in the document — nothing to mount into. This should never
    // happen with index.html as shipped, but a missing mount point must
    // never throw an uncaught error into the webview.
    return;
  }

  const bridge = hasTauri() ? tauriBridge() : devBridge();
  mountApp(root, bridge);
}

document.addEventListener("DOMContentLoaded", boot);
