/**
 * Cert Verify View — the "drop in a certificate" panel on the Trust surface.
 *
 * Renders inside the Tauri native webview (not a website). It presents the
 * verdict from `../core/cert-verify.ts`: every check pass/fail, the payload
 * fields the user actually cares about (tier, P(correct), epsilon, task id,
 * issued time), and the issuing public key. A null result shows an empty state
 * prompting the user to paste a certificate.
 *
 * Pure render function: (result) -> HTML string. No DOM, no I/O. Directly
 * unit-testable. Styling uses the shared theme tokens and matches the
 * `trust-*` class conventions in `trust-view.ts`.
 */

import type { CertVerifyResult } from "../core/cert-verify";

// ---------------------------------------------------------------------------
// Escaping (same convention as trust-view.ts)
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

/** first8…last8 so a key can be checked by eye without dumping the whole thing. */
function truncateHex(hex: string): string {
  if (hex.length <= 20) return hex;
  return `${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

function formatIssuedAt(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return "unknown time";
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

// ---------------------------------------------------------------------------
// Sub-renderers
// ---------------------------------------------------------------------------

function renderCheck(check: CertVerifyResult["checks"][number]): string {
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
}

function renderPayload(result: CertVerifyResult): string {
  const p = result.payload;
  if (!p) return "";
  const rows: Array<[string, string]> = [
    ["Verifier tier", p.verifierTier],
    ["P(correct)", pct(p.pCorrect, 1)],
    ["Silent wrong bound", `silent wrong &le; &epsilon; (${pct(p.epsilon, 2)})`],
    ["Task", p.taskId],
    ["Issued", formatIssuedAt(p.issuedAt)],
  ];
  const items = rows
    .map(
      ([label, value]) => `
        <div class="cert-verify__stat">
          <dt class="cert-verify__label">${escapeHtml(label)}</dt>
          <dd class="cert-verify__value">${label === "Silent wrong bound" ? value : escapeHtml(value)}</dd>
        </div>`,
    )
    .join("");
  return `<dl class="cert-verify__stats">${items}</dl>`;
}

function renderPublicKey(result: CertVerifyResult): string {
  if (!result.publicKey) return "";
  return `
    <div class="cert-verify__key-block">
      <span class="cert-verify__label">Issuing public key</span>
      <code class="trust-mono cert-verify__key" title="${escapeHtml(result.publicKey)}">${escapeHtml(
        truncateHex(result.publicKey),
      )}</code>
    </div>`;
}

// ---------------------------------------------------------------------------
// renderCertVerify — the whole panel
// ---------------------------------------------------------------------------

/**
 * Render the certificate verification panel. Pass the result of
 * `verifyDropped`, or `null` for the empty state that prompts a paste.
 */
export function renderCertVerify(result: CertVerifyResult | null): string {
  if (result === null) {
    return `
      <div class="cert-verify cert-verify--empty">
        <h2 class="trust-view__section-title">Verify a certificate</h2>
        <p class="trust-view__empty">
          Paste a Verification Certificate JSON to check its ed25519 signature and trace hash.
        </p>
      </div>`;
  }

  const tone = result.valid ? "ok" : "bad";
  const verdictLabel = result.valid ? "Authentic" : "Not verified";

  const checksBlock =
    result.checks.length > 0
      ? `<ul class="cert-verify__checks">${result.checks.map(renderCheck).join("")}</ul>`
      : `<p class="trust-view__empty trust-view__empty--inline">No checks recorded.</p>`;

  return `
    <div class="cert-verify cert-verify--${tone}" data-valid="${result.valid ? "true" : "false"}">
      <header class="cert-verify__header">
        <h2 class="trust-view__section-title">Verify a certificate</h2>
        <span class="cert-verify__verdict cert-verify__verdict--${tone}">${escapeHtml(verdictLabel)}</span>
      </header>
      <p class="cert-verify__reason">${escapeHtml(result.reason)}</p>
      ${checksBlock}
      ${renderPayload(result)}
      ${renderPublicKey(result)}
    </div>`;
}
