/**
 * Zero-RTT classification for canned command failures.
 *
 * `classifyCommandFailure` used to ask Jev (or fail-closed) for every
 * nonzero exit. ENOENT / EACCES / ETIMEDOUT do not need a 70–500ms hop,
 * and they should not kill the run when TypeSafe is down. Ambiguous
 * stderr still goes to Jev; secrets stay `leaks-secret-local`.
 */

import type { PolicyDecision } from "./types";

export type FailureClass = "transient" | "environment" | "permission" | "code_bug" | "user_error";

const PERMISSION: RegExp[] = [
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bpermission denied\b/i,
  /\b(?:401|403)\b.*\b(?:unauthorized|forbidden)\b/i,
  /\baccess denied\b/i,
];

const TRANSIENT: RegExp[] = [
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bEAGAIN\b/,
  /\bEAI_AGAIN\b/,
  /\bENETUNREACH\b/,
  /\bsocket hang up\b/i,
  /\btemporarily unavailable\b/i,
  /\b(?:429|502|503|504)\b/,
];

const ENVIRONMENT: RegExp[] = [
  /\bENOENT\b/,
  /\bENOTDIR\b/,
  /\bMODULE_NOT_FOUND\b/,
  /\bcommand not found\b/i,
  /\bno such file or directory\b/i,
  /\bnot installed\b/i,
  /\bNo such file or directory\b/,
];

const CODE_BUG: RegExp[] = [
  /\bTypeError\b/,
  /\bReferenceError\b/,
  /\bSyntaxError\b/,
  /\bRangeError\b/,
  /\bAssertionError\b/,
];

const USER_ERROR: RegExp[] = [
  /\bunknown option\b/i,
  /\binvalid argument\b/i,
  /\bunrecognized option\b/i,
  /^usage:/im,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}

export function localFailureDecision(output: string): PolicyDecision | null {
  if (!output) return null;
  if (matchesAny(output, PERMISSION)) {
    return { action: "auto", value: "permission", reason: "failure-local", node: "command_failure" };
  }
  if (matchesAny(output, TRANSIENT)) {
    return { action: "auto", value: "transient", reason: "failure-local", node: "command_failure" };
  }
  if (matchesAny(output, ENVIRONMENT)) {
    return { action: "auto", value: "environment", reason: "failure-local", node: "command_failure" };
  }
  if (matchesAny(output, CODE_BUG)) {
    return { action: "auto", value: "code_bug", reason: "failure-local", node: "command_failure" };
  }
  if (matchesAny(output, USER_ERROR)) {
    return { action: "auto", value: "user_error", reason: "failure-local", node: "command_failure" };
  }
  return null;
}
