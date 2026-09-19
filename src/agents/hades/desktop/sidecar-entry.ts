#!/usr/bin/env npx tsx
/**
 * Process entry for the Hades desktop sidecar.
 * Tauri: spawn this as the child and pipe stdio.
 */

import { runDesktopSidecar } from "./sidecar";

void runDesktopSidecar().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
