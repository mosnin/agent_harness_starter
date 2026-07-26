import { describe, it, expect } from "vitest";
import { createApp, type Bridge } from "../ui/renderer";
import type { Command, AppEvent } from "../ipc/contract";
import { CertificateAuthority, generatePrivateKeyHex, sha256Hex } from "../../hades/styx/certificate";
import type { CertificatePayload } from "../../hades/styx/certificate";

/**
 * Phase 3 renderer integration: proves the new surfaces (command palette,
 * Compare/head-to-head view, Metrics/V-TPH$ view, cert-verify in Trust) are
 * really wired into the app controller, driving the real modules, not stubs.
 */

function makeFakeBridge() {
  const sent: Command[] = [];
  let handler: ((e: AppEvent) => void) | null = null;
  const bridge: Bridge = {
    send(cmd) {
      sent.push(cmd);
    },
    onEvent(cb) {
      handler = cb;
      return () => {
        handler = null;
      };
    },
    async start() {},
    async stop() {
      handler = null;
    },
  };
  return {
    bridge,
    sent,
    push(ev: AppEvent) {
      handler?.(ev);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("renderer phase 3 — new nav surfaces", () => {
  it("Compare view renders a Run button and runCompare fills real benchmark rows", async () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "compare" });

    const before = app.html();
    expect(before).toContain('data-active="compare"');
    expect(before).toContain('data-cmd="compare.run"');

    app.runCompare();
    // Poll until the async in-memory benchmark resolves.
    let after = "";
    for (let i = 0; i < 50; i++) {
      await tick();
      after = app.html();
      if (/routing/i.test(after) && !/Running the in-memory benchmark/.test(after)) break;
    }
    // Real head-to-head output mentions the routing comparison and worker counts.
    expect(after.toLowerCase()).toContain("routing");
    expect(after).toContain("data-active=\"compare\"");
  });

  it("Metrics view computes an honest V-TPH$ panel from real state", async () => {
    const { bridge, push } = makeFakeBridge();
    const app = createApp(bridge, {
      initialNav: "metrics",
      now: (() => {
        let t = 1_000;
        return () => (t += 1_000_000);
      })(),
    });

    // No verified work yet -> honest "awaiting", never a fabricated number.
    let html = "";
    for (let i = 0; i < 50; i++) {
      await tick();
      html = app.html();
      if (!/Computing V-TPH/.test(html)) break;
    }
    expect(html).toContain('data-active="metrics"');
    expect(html.toLowerCase()).toMatch(/awaiting|n\/a/);

    // Feed real metrics with verified work + cost; the panel recomputes.
    push({ kind: "runtime.status", running: true, mode: "inline", poolSize: 2 });
    push({
      kind: "metrics",
      metrics: {
        goalsCompleted: 1,
        goalsTotal: 1,
        groundingRate: 1,
        costUsd: 2,
        verifiedTasks: 4,
        rejectedTasks: 0,
      },
    });
    for (let i = 0; i < 50; i++) {
      await tick();
      html = app.html();
      if (/V-TPH/i.test(html) && !/Computing V-TPH/.test(html)) break;
    }
    expect(html).toContain('data-active="metrics"');
    expect(html).toMatch(/V-TPH/i);
  });
});

describe("renderer phase 3 — command palette", () => {
  it("opens, filters, and executes a real Command through the bridge", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge);

    expect(app.html()).not.toContain('data-palette-open="true"');

    app.palette({ type: "open" });
    expect(app.html()).toContain('data-palette-open="true"');

    // Filter to the "Start runtime" entry and execute it.
    app.palette({ type: "setQuery", query: "start runtime" });
    app.palette({ type: "execute" });

    expect(sent.some((c) => c.kind === "runtime.start")).toBe(true);
  });

  it("close leaves no overlay", () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge);
    app.palette({ type: "open" });
    app.palette({ type: "close" });
    expect(app.html()).not.toContain('data-palette-open="true"');
  });
});

describe("renderer phase 3 — cert verify in Trust", () => {
  it("verifies a genuinely signed certificate as authentic", async () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "trust" });

    expect(app.html()).toContain('id="cert-input"');

    const priv = generatePrivateKeyHex();
    const ca = new CertificateAuthority(priv);
    const payload: CertificatePayload = {
      outputSha256: sha256Hex("the delivered answer"),
      taskId: "t-1",
      verifierTier: "T2-genrm",
      ensembleScore: 0.91,
      pCorrect: 0.9,
      epsilon: 0.05,
      traceSha256: sha256Hex("trace"),
      verifierVersions: ["genrm@1"],
      issuedAt: 1_700_000_000_000,
    };
    const cert = await ca.issue(payload);

    app.verifyCert(JSON.stringify(cert));
    let html = "";
    for (let i = 0; i < 50; i++) {
      await tick();
      html = app.html();
      if (/authentic/i.test(html)) break;
    }
    expect(html.toLowerCase()).toContain("authentic");
  });

  it("marks a tampered certificate as not verified", async () => {
    const { bridge } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "trust" });

    const priv = generatePrivateKeyHex();
    const ca = new CertificateAuthority(priv);
    const cert = await ca.issue({
      outputSha256: sha256Hex("x"),
      taskId: "t-2",
      verifierTier: "T0-execution",
      ensembleScore: 0.8,
      pCorrect: 0.8,
      epsilon: 0.1,
      traceSha256: sha256Hex("tr"),
      verifierVersions: ["v@1"],
      issuedAt: 1_700_000_000_000,
    });
    // Tamper a signed field.
    const tampered = { ...cert, payload: { ...cert.payload, pCorrect: 0.999 } };

    app.verifyCert(JSON.stringify(tampered));
    let html = "";
    for (let i = 0; i < 50; i++) {
      await tick();
      html = app.html();
      if (/not verified/i.test(html)) break;
    }
    expect(html.toLowerCase()).toContain("not verified");
  });
});
