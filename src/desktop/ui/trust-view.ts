/**
 * Trust View — the Hades desktop app's signature surface.
 *
 * Renders inside the Tauri native webview (not a website). It answers one
 * question at a glance: "is the swarm producing trustworthy work?" — a hero
 * trust number, the verification gate feed (every accept/reject decision
 * with its per-check breakdown), and a certificate showcase presenting the
 * ed25519-signed Verification Certificate as something worth framing.
 *
 * Pure, framework-light render functions: (state) -> HTML string. No DOM,
 * no timers, no I/O. Safe to unit test directly.
 */

import type { AppState } from "../core/app-store";
import { selectors } from "../core/app-store";
import type { VerificationView, CertificateView } from "../ipc/contract";

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

/** Escapes text for safe interpolation into HTML markup or attributes. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function pct(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return "0%";
  return `${(fraction * 100).toFixed(digits)}%`;
}

/** first8…last8 so a certificate can be verified by eye without dumping the whole key. */
function truncateSignature(signature: string): string {
  if (signature.length <= 20) return signature;
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

function formatIssuedAt(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "unknown time";
  const iso = new Date(epochMs).toISOString();
  // "2026-07-18T09:41:03.000Z" -> "2026-07-18 09:41:03 UTC"
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

const VERDICT_LABEL: Record<VerificationView["verdict"], string> = {
  accept: "Accepted",
  reject: "Rejected",
  revise: "Needs revision",
};

const VERDICT_TONE: Record<VerificationView["verdict"], "ok" | "bad" | "warn"> = {
  accept: "ok",
  reject: "bad",
  revise: "warn",
};

// ---------------------------------------------------------------------------
// trustHeadline — the four numbers the hero answers with
// ---------------------------------------------------------------------------

export function trustHeadline(state: AppState): {
  grounded: number;
  verified: number;
  rejected: number;
  silentWrong: number;
} {
  const grounded = selectors.groundingPct(state);
  const verified = selectors.verifiedCount(state);
  const rejected = selectors.rejectedCount(state);

  // "Silent wrong": a certificate was issued (the gate vouched this task's
  // work as correct within its epsilon bound) but the task's own status
  // later landed on rejected/failed. That is precisely the failure mode a
  // verification system exists to drive to zero — an unnoticed wrong
  // answer that shipped with a certificate attached.
  const statusByTaskId = new Map(state.tasks.map((t) => [t.id, t.status]));
  const silentWrong = state.certificates.filter((cert) => {
    const status = statusByTaskId.get(cert.taskId);
    return status === "rejected" || status === "failed";
  }).length;

  return { grounded, verified, rejected, silentWrong };
}

// ---------------------------------------------------------------------------
// renderVerification — one gate decision, accept/reject card
// ---------------------------------------------------------------------------

export function renderVerification(v: VerificationView): string {
  const tone = VERDICT_TONE[v.verdict];
  const label = VERDICT_LABEL[v.verdict];
  const scoreLabel = pct(v.score);

  const checks = v.checks
    .map((check) => {
      const passed = check.passed;
      const icon = passed ? "✓" : "✗";
      const iconClass = passed ? "trust-check__icon--pass" : "trust-check__icon--fail";
      return `
        <li class="trust-check ${passed ? "trust-check--pass" : "trust-check--fail"}">
          <span class="trust-check__icon ${iconClass}" aria-hidden="true">${icon}</span>
          <span class="trust-check__body">
            <span class="trust-check__name">${escapeHtml(check.name)}</span>
            <span class="trust-check__detail">${escapeHtml(check.detail)}</span>
          </span>
        </li>`;
    })
    .join("");

  const checksBlock =
    v.checks.length > 0
      ? `<ul class="trust-verification__checks">${checks}</ul>`
      : `<p class="trust-view__empty trust-view__empty--inline">No checks recorded.</p>`;

  return `
    <article class="trust-verification trust-verification--${tone}" data-verdict="${escapeHtml(v.verdict)}">
      <header class="trust-verification__header">
        <span class="trust-verification__verdict trust-verification__verdict--${tone}">${escapeHtml(label)}</span>
        <span class="trust-verification__score">${scoreLabel}</span>
      </header>
      <p class="trust-verification__meta">
        Task <code class="trust-mono">${escapeHtml(v.taskId)}</code>
        &middot; Worker <code class="trust-mono">${escapeHtml(v.workerId)}</code>
      </p>
      ${checksBlock}
    </article>`;
}

// ---------------------------------------------------------------------------
// renderCertificate — the sealed Verification Certificate
// ---------------------------------------------------------------------------

export function renderCertificate(c: CertificateView): string {
  const pCorrectLabel = pct(c.pCorrect, 1);
  const epsilonLabel = pct(c.epsilon, 2);
  const sigDisplay = truncateSignature(c.signature);
  const issued = formatIssuedAt(c.issuedAt);

  return `
    <article class="trust-cert" data-tier="${escapeHtml(c.tier)}">
      <div class="trust-cert__seal" aria-hidden="true"></div>
      <header class="trust-cert__header">
        <span class="trust-cert__eyebrow">Verification Certificate</span>
        <span class="trust-cert__tier">${escapeHtml(c.tier)}</span>
      </header>
      <p class="trust-cert__task">
        Task <code class="trust-mono">${escapeHtml(c.taskId)}</code>
      </p>
      <dl class="trust-cert__stats">
        <div class="trust-cert__stat">
          <dt class="trust-cert__label">P(correct)</dt>
          <dd class="trust-cert__value trust-cert__value--pcorrect">${pCorrectLabel}</dd>
        </div>
        <div class="trust-cert__stat">
          <dt class="trust-cert__label">Silent wrong bound</dt>
          <dd class="trust-cert__value trust-cert__value--epsilon">silent wrong &le; &epsilon; (${epsilonLabel})</dd>
        </div>
      </dl>
      <div class="trust-cert__signature-block">
        <span class="trust-cert__label">Ed25519 signature</span>
        <code class="trust-mono trust-cert__signature">${escapeHtml(sigDisplay)}</code>
      </div>
      <footer class="trust-cert__footer">
        <span class="trust-cert__issued">Issued ${escapeHtml(issued)}</span>
      </footer>
    </article>`;
}

// ---------------------------------------------------------------------------
// renderTrustView — hero trust number + gate feed + certificate showcase
// ---------------------------------------------------------------------------

export function renderTrustView(state: AppState): string {
  const headline = trustHeadline(state);

  const hero = `
    <section class="trust-view__hero" aria-label="Trust summary">
      <div class="trust-view__hero-stat trust-view__hero-stat--grounded">
        <span class="trust-view__hero-number">${headline.grounded}%</span>
        <span class="trust-view__hero-label">Grounded</span>
      </div>
      <div class="trust-view__hero-stat trust-view__hero-stat--verified">
        <span class="trust-view__hero-number">${headline.verified}</span>
        <span class="trust-view__hero-label">Verified</span>
      </div>
      <div class="trust-view__hero-stat trust-view__hero-stat--rejected">
        <span class="trust-view__hero-number">${headline.rejected}</span>
        <span class="trust-view__hero-label">Rejected</span>
      </div>
      <div class="trust-view__hero-stat trust-view__hero-stat--silent-wrong ${
        headline.silentWrong === 0 ? "trust-view__hero-stat--good" : "trust-view__hero-stat--bad"
      }">
        <span class="trust-view__hero-number">${headline.silentWrong}</span>
        <span class="trust-view__hero-label">Silent wrong</span>
      </div>
    </section>`;

  const feedItems = state.verifications.length
    ? state.verifications
        .slice()
        .reverse()
        .map((v) => renderVerification(v))
        .join("")
    : `<p class="trust-view__empty">No verification decisions yet. The gate is idle.</p>`;

  const gateFeed = `
    <section class="trust-view__gate" aria-label="Verification gate feed">
      <h2 class="trust-view__section-title">Verification gate</h2>
      <div class="trust-view__gate-feed">${feedItems}</div>
    </section>`;

  const latestCert = selectors.latestCertificate(state);
  const certBlock = latestCert
    ? renderCertificate(latestCert)
    : `<p class="trust-view__empty">No certificate has been sealed yet.</p>`;

  const certShowcase = `
    <section class="trust-view__cert-showcase" aria-label="Verification certificate">
      <h2 class="trust-view__section-title">Latest certificate</h2>
      ${certBlock}
    </section>`;

  return `<div class="trust-view">${hero}${gateFeed}${certShowcase}</div>`;
}
