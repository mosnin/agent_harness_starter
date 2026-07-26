/**
 * Tests for `scripts/package-desktop.mjs` — the honest desktop packaging
 * orchestrator.
 *
 * These tests exercise the orchestration as PURE, injectable functions. They
 * never run `cargo`, never spawn the Tauri CLI, and never open a display: the
 * `cargo tauri build` step is asserted only as a planned command string, and
 * the bundle halves are injected as fakes so nothing real is bundled either.
 * That's exactly the boundary the script is designed around — the JS halves
 * can run headless, the native half cannot, so the native half is only ever
 * *described* in a headless environment.
 */
import { describe, it, expect } from "vitest";
import {
  detectPrerequisites,
  planPackage,
  packageDesktop,
  parseArgs,
  lookupOnPath,
  TAURI_BUILD_COMMAND,
  BUNDLE_TARGETS,
} from "../../../scripts/package-desktop.mjs";

/** A fake `which` built from the set of command names that "exist". */
function fakeLookup(present: string[]) {
  return (cmd: string) => (present.includes(cmd) ? `/fake/bin/${cmd}` : null);
}

describe("TAURI_BUILD_COMMAND", () => {
  it("is the exact feature-gated gui build command", () => {
    // Must stay consistent with docs/DESKTOP_APP.md + package.json desktop:dev,
    // which use `--features gui`.
    expect(TAURI_BUILD_COMMAND).toBe("cd src-tauri && cargo tauri build --features gui");
  });
});

describe("detectPrerequisites (pure, fake `which`)", () => {
  it("reports ready when cargo + cargo-tauri + display are all present", () => {
    const result = detectPrerequisites({
      lookup: fakeLookup(["cargo", "cargo-tauri"]),
      env: { DISPLAY: ":0" },
      platform: "linux",
    });
    expect(result).toMatchObject({ cargo: true, cargoTauri: true, hasDisplay: true, ready: true });
    expect(result.missing).toEqual([]);
  });

  it("accepts a bare `tauri` binary as equivalent to `cargo-tauri`", () => {
    const result = detectPrerequisites({
      lookup: fakeLookup(["cargo", "tauri"]),
      env: { DISPLAY: ":0" },
      platform: "linux",
    });
    expect(result.cargoTauri).toBe(true);
    expect(result.ready).toBe(true);
  });

  it("is NOT ready on headless linux with no DISPLAY, and says why", () => {
    const result = detectPrerequisites({
      lookup: fakeLookup(["cargo", "cargo-tauri"]),
      env: {},
      platform: "linux",
    });
    expect(result.hasDisplay).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.missing.some((m) => m.includes("display"))).toBe(true);
  });

  it("reports every missing tool when nothing is installed", () => {
    const result = detectPrerequisites({
      lookup: fakeLookup([]),
      env: {},
      platform: "linux",
    });
    expect(result).toMatchObject({ cargo: false, cargoTauri: false, hasDisplay: false, ready: false });
    expect(result.missing).toHaveLength(3);
  });

  it("treats macOS/Windows as always having a display context", () => {
    for (const platform of ["darwin", "win32"] as const) {
      const result = detectPrerequisites({
        lookup: fakeLookup(["cargo", "cargo-tauri"]),
        env: {},
        platform,
      });
      expect(result.hasDisplay).toBe(true);
      expect(result.ready).toBe(true);
    }
  });
});

describe("lookupOnPath (pure PATH resolution, no child process)", () => {
  it("returns null for a command that is not on the given PATH", () => {
    expect(
      lookupOnPath("definitely-not-a-real-binary-xyz", { env: { PATH: "/nonexistent" }, platform: "linux" })
    ).toBeNull();
  });

  it("returns null when PATH is empty", () => {
    expect(lookupOnPath("cargo", { env: {}, platform: "linux" })).toBeNull();
  });
});

describe("planPackage (pure)", () => {
  it("in dry-run: bundle steps run, tauri step is skipped but carries the exact command", () => {
    const prerequisites = detectPrerequisites({ lookup: fakeLookup([]), env: {}, platform: "linux" });
    const plan = planPackage({ prerequisites, dryRun: true });

    expect(plan.dryRun).toBe(true);
    expect(plan.tauriCommand).toBe(TAURI_BUILD_COMMAND);

    const byName = Object.fromEntries(plan.steps.map((s: any) => [s.name, s]));
    expect(byName["bundle-sidecar"].action).toBe("run");
    expect(byName["bundle-ui"].action).toBe("run");
    expect(byName["tauri-build"].action).toBe("skip");
    expect(byName["tauri-build"].command).toBe(TAURI_BUILD_COMMAND);
  });

  it("in full mode: the tauri step is marked to run", () => {
    const prerequisites = detectPrerequisites({
      lookup: fakeLookup(["cargo", "cargo-tauri"]),
      env: { DISPLAY: ":0" },
      platform: "linux",
    });
    const plan = planPackage({ prerequisites, dryRun: false });
    const tauri = plan.steps.find((s: any) => s.name === "tauri-build");
    expect(tauri.action).toBe("run");
  });
});

describe("packageDesktop orchestration (fakes; never touches cargo or a display)", () => {
  const fakeSidecar = async () => ({ skipped: false, outfile: "/fake/dist/desktop/sidecar-entry.js" });
  const fakeUi = async () => ({ ok: true, outdir: "/fake/dist/desktop", config: {} });
  const silent = () => {};

  it("auto-selects dry-run when prerequisites are absent and does NOT run tauri", async () => {
    let tauriCalled = false;
    const result = await packageDesktop({
      buildSidecarFn: fakeSidecar,
      buildUiFn: fakeUi,
      lookup: fakeLookup([]),
      env: {},
      platform: "linux",
      log: silent,
      logError: silent,
      runTauri: () => {
        tauriCalled = true;
        return { status: 0 };
      },
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.tauriRan).toBe(false);
    expect(tauriCalled).toBe(false);
    // The plan still carries the real command for the caller to run manually.
    expect(result.plan.tauriCommand).toBe(TAURI_BUILD_COMMAND);
  });

  it("runs both bundle halves (via the injected fakes) even in dry-run", async () => {
    let sidecarRan = false;
    let uiRan = false;
    const result = await packageDesktop({
      buildSidecarFn: async () => {
        sidecarRan = true;
        return { skipped: false, outfile: "/fake/sidecar.js" };
      },
      buildUiFn: async () => {
        uiRan = true;
        return { ok: true, outdir: "/fake/dist" };
      },
      lookup: fakeLookup([]),
      env: {},
      platform: "linux",
      log: silent,
      logError: silent,
    });
    expect(sidecarRan).toBe(true);
    expect(uiRan).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("only invokes the tauri runner when forced full AND prerequisites are met", async () => {
    let tauriCalled = false;
    const result = await packageDesktop({
      dryRun: false,
      buildSidecarFn: fakeSidecar,
      buildUiFn: fakeUi,
      lookup: fakeLookup(["cargo", "cargo-tauri"]),
      env: { DISPLAY: ":0" },
      platform: "linux",
      log: silent,
      logError: silent,
      runTauri: () => {
        tauriCalled = true;
        return { status: 0 };
      },
    });
    expect(tauriCalled).toBe(true);
    expect(result.tauriRan).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("returns ok:false with the failing step name when the tauri runner exits non-zero", async () => {
    const result = await packageDesktop({
      dryRun: false,
      buildSidecarFn: fakeSidecar,
      buildUiFn: fakeUi,
      lookup: fakeLookup(["cargo", "cargo-tauri"]),
      env: { DISPLAY: ":0" },
      platform: "linux",
      log: silent,
      logError: silent,
      runTauri: () => ({ status: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("tauri-build");
  });

  it("returns ok:false when a bundle step throws (a real, attempted failure)", async () => {
    const result = await packageDesktop({
      buildSidecarFn: async () => {
        throw new Error("boom");
      },
      buildUiFn: fakeUi,
      lookup: fakeLookup([]),
      env: {},
      platform: "linux",
      log: silent,
      logError: silent,
    });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe("bundle-sidecar");
  });

  it("treats an esbuild-missing bundle skip as a non-fatal success", async () => {
    const result = await packageDesktop({
      buildSidecarFn: async () => ({ skipped: true, reason: "esbuild-missing", outfile: "/fake/x.js" }),
      buildUiFn: async () => ({ ok: false, reason: "esbuild-missing", outdir: "/fake" }),
      lookup: fakeLookup([]),
      env: {},
      platform: "linux",
      log: silent,
      logError: silent,
    });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
  });
});

describe("parseArgs", () => {
  it("maps --dry-run to dryRun:true", () => {
    expect(parseArgs(["--dry-run"])).toEqual({ dryRun: true });
  });
  it("maps --full / --no-dry-run to dryRun:false", () => {
    expect(parseArgs(["--full"])).toEqual({ dryRun: false });
    expect(parseArgs(["--no-dry-run"])).toEqual({ dryRun: false });
  });
  it("defaults to no forced mode (auto) with no flags", () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe("BUNDLE_TARGETS", () => {
  it("matches the installer targets declared in tauri.conf.json", () => {
    const targets = BUNDLE_TARGETS.map((t) => t.target).sort();
    expect(targets).toEqual(["app", "appimage", "deb", "dmg", "msi", "nsis"].sort());
  });
});
