import { describe, it, expect } from "vitest";
import { renderTrustView, renderVerification, renderCertificate, trustHeadline } from "../ui/trust-view";
import { initialState, type AppState } from "../core/app-store";
import type { VerificationView, CertificateView, TaskView } from "../ipc/contract";

function task(overrides: Partial<TaskView>): TaskView {
  return {
    id: "t-1",
    description: "do the thing",
    status: "verified",
    requiredCapabilities: [],
    attempts: 1,
    maxAttempts: 3,
    ...overrides,
  };
}

function verification(overrides: Partial<VerificationView>): VerificationView {
  return {
    taskId: "t-1",
    workerId: "w-1",
    verdict: "accept",
    score: 0.92,
    checks: [
      { name: "lint", passed: true, detail: "no issues" },
      { name: "tests", passed: false, detail: "2 failing" },
    ],
    ...overrides,
  };
}

function certificate(overrides: Partial<CertificateView>): CertificateView {
  return {
    taskId: "t-1",
    tier: "gold",
    pCorrect: 0.97,
    epsilon: 0.021,
    signature:
      "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
    issuedAt: Date.UTC(2026, 6, 18, 9, 41, 3),
    ...overrides,
  };
}

function sampleState(): AppState {
  const state = initialState();
  return {
    ...state,
    tasks: [
      task({ id: "t-1", status: "verified" }),
      task({ id: "t-2", status: "rejected" }),
      task({ id: "t-3", status: "rejected" }),
    ],
    verifications: [
      verification({ taskId: "t-1", workerId: "w-1", verdict: "accept", score: 0.92 }),
      verification({ taskId: "t-2", workerId: "w-2", verdict: "reject", score: 0.31 }),
    ],
    certificates: [
      certificate({ taskId: "t-1", tier: "gold" }),
      // Issued for a task that later ended up rejected: a silent-wrong case.
      certificate({ taskId: "t-3", tier: "silver" }),
    ],
    metrics: {
      goalsCompleted: 1,
      goalsTotal: 2,
      groundingRate: 0.876,
      costUsd: 0.42,
      verifiedTasks: 1,
      rejectedTasks: 2,
      // (extra realism only; groundingRate is the field consumed)
    },
  };
}

describe("trustHeadline", () => {
  it("computes grounded / verified / rejected / silentWrong from state (hand-verified)", () => {
    const state = sampleState();
    const headline = trustHeadline(state);
    // grounded: round(0.876 * 100) = 88
    expect(headline.grounded).toBe(88);
    // verified: tasks with status "verified" -> only t-1
    expect(headline.verified).toBe(1);
    // rejected: verifications with verdict !== "accept" -> the reject on t-2
    expect(headline.rejected).toBe(1);
    // silentWrong: certificates whose task later ended rejected/failed -> t-3's cert
    expect(headline.silentWrong).toBe(1);
  });

  it("reads all zeros on an empty state (nothing to distrust yet)", () => {
    const headline = trustHeadline(initialState());
    expect(headline).toEqual({ grounded: 0, verified: 0, rejected: 0, silentWrong: 0 });
  });
});

describe("renderTrustView", () => {
  it("shows the four headline numbers from a sample state", () => {
    const html = renderTrustView(sampleState());
    expect(html).toContain("88%");
    expect(html).toContain('<span class="trust-view__hero-number">1</span>'); // verified
    // both rejected (1) and silentWrong (1) render as "1" hero numbers too;
    // assert the count of hero-number spans matches the four stats.
    const matches = html.match(/trust-view__hero-number/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it("renders empty states when there are no verifications or certificates", () => {
    const html = renderTrustView(initialState());
    expect(html).toContain("No verification decisions yet");
    expect(html).toContain("No certificate has been sealed yet");
  });
});

describe("renderVerification", () => {
  it("shows the verdict, each check with a check/cross mark, and the score percentage", () => {
    const html = renderVerification(
      verification({
        verdict: "accept",
        score: 0.92,
        checks: [
          { name: "lint", passed: true, detail: "clean" },
          { name: "tests", passed: false, detail: "2 failing" },
        ],
      })
    );
    expect(html).toContain("Accepted");
    expect(html).toContain("92%");
    expect(html).toContain("✓");
    expect(html).toContain("✗");
    expect(html).toContain("lint");
    expect(html).toContain("tests");
  });

  it("renders a passed-only card cleanly (no failing marks) when every check passes", () => {
    const html = renderVerification(
      verification({
        verdict: "accept",
        checks: [{ name: "lint", passed: true, detail: "clean" }],
      })
    );
    expect(html).toContain("✓");
    expect(html).not.toContain("✗");
  });
});

describe("renderCertificate", () => {
  it("shows tier, P(correct) percentage, the epsilon bound, and a truncated signature", () => {
    const cert = certificate({});
    const html = renderCertificate(cert);
    expect(html).toContain("gold");
    expect(html).toContain("97.0%"); // pCorrect
    expect(html).toContain("&epsilon;");
    expect(html).toContain("2.10%"); // epsilon
    // Truncated to first 8 + last 8 chars, joined by an ellipsis.
    expect(html).toContain(`${cert.signature.slice(0, 8)}…${cert.signature.slice(-8)}`);
    // The full 96-char signature must never appear verbatim in the markup.
    expect(html).not.toContain(cert.signature);
  });
});

describe("escaping", () => {
  it("escapes dynamic text in verification checks", () => {
    const html = renderVerification(
      verification({
        taskId: '<img src=x onerror=alert(1)>',
        checks: [{ name: "<script>bad()</script>", passed: false, detail: '"quoted" & <tag>' }],
      })
    );
    expect(html).not.toContain("<script>bad()</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("escapes dynamic text in certificate fields", () => {
    const html = renderCertificate(
      certificate({ tier: '<b>gold</b>', taskId: '"><script>x</script>' })
    );
    expect(html).not.toContain("<b>gold</b>");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;b&gt;gold&lt;/b&gt;");
  });
});
