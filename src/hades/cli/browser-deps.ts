/* ------------------------------------------------------------------ *
 * browser-deps.ts — CENTRAL INTEGRATION of `hades browser`'s deps seam.
 *
 * `browser-command.ts` was built terminal-free against an injected
 * `BrowserCliDeps` (node built-ins only, per its locked import
 * boundary). This module is the product wiring that fills that seam
 * with the real thing:
 *
 *   browse -> the real `browser` CatalogEntry (tool.ts) backed by the
 *             real driver+extract+trace runner (runner.ts). The tool
 *             itself decides real-vs-mock honestly at construction from
 *             its own Chromium fs-probe; a machine without Chromium gets
 *             the clearly "[mock]"-labelled deterministic stand-in.
 *   bench  -> the real browse-bench checkpoint (browse-bench.ts): a
 *             genuine local fixture site, a genuine Chromium launch,
 *             ground-truth-checked citations, verified hash chain.
 *   probe  -> driver-core's honest `resolveChromiumExecutable` +
 *             `probeDisplaySupport` (never pretends a display exists).
 *
 * This file statically imports `playwright-core`-dependent modules, so
 * `cli.ts` loads it lazily (dynamic import) only when the `browser`
 * subcommand is actually invoked — CLI startup stays instant and an
 * environment without playwright-core degrades to an honest error
 * message instead of a crashed CLI.
 * ------------------------------------------------------------------ */

import { createBrowserTool } from "../browser/tool";
import { createBrowseRunner } from "../browser/runner";
import { runBrowseBench } from "../browser/browse-bench";
import { resolveChromiumExecutable, probeDisplaySupport } from "../browser/driver";
import type {
  BrowserCliDeps,
  BrowserOpenRequest,
  BrowserOpenResult,
  BrowserProbeResult,
} from "./browser-command";

export interface BrowserDepsIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/**
 * Build the real `BrowserCliDeps` for `buildBrowserCommand`. Only the
 * output sinks are injected by the caller; every capability is the
 * genuine article described in the header above.
 */
export function defaultBrowserCliDeps(io: BrowserDepsIo): BrowserCliDeps {
  return {
    stdout: io.stdout,
    stderr: io.stderr,

    browse: async (req: BrowserOpenRequest): Promise<BrowserOpenResult> => {
      const entry = createBrowserTool({ runner: createBrowseRunner() });
      const input = JSON.stringify(
        req.maxBytes === undefined
          ? { op: "browse", url: req.url }
          : { op: "browse", url: req.url, maxBytes: req.maxBytes }
      );
      const result = await entry.tool.run(input);
      return { ok: result.ok, output: result.output };
    },

    bench: () => runBrowseBench(),

    probe: (): BrowserProbeResult => {
      const chromium = resolveChromiumExecutable();
      const display = probeDisplaySupport();
      const probe: BrowserProbeResult = {
        chromiumFound: chromium.ok,
        headedOk: display.headedOk,
      };
      if (chromium.ok) probe.chromiumPath = chromium.path;
      const reason = chromium.ok ? display.reason : chromium.reason;
      if (reason !== undefined) probe.reason = reason;
      return probe;
    },
  };
}
