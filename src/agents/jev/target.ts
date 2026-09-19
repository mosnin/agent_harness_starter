/**
 * Zero-RTT block for canned exfil / SSRF targets.
 *
 * `file_read` and `web_search` skip Auto Mode as "safe reads", so
 * `../.env`, `/etc/passwd`, and `http://169.254.169.254/` never reached
 * Jev. `shell_exec` only scanned path/url keys, so `cat /etc/passwd`
 * also skipped the label. Interpreter one-liners (`python -c open(...)`)
 * are the same class. Those strings do not need a 70–500ms hop.
 * Search queries and echo/README mentions are not blocked.
 * Write verbs and redirects to those same paths (`tee`, `cp`, `>`)
 * are the same class — overwriting a secret file does not need Jev.
 */

import { commandFromToolArgs } from "./destructive";
import type { PolicyDecision } from "./types";

const PATH_KEYS = new Set([
  "path",
  "file",
  "filename",
  "filepath",
  "dest",
  "destination",
  "dir",
  "directory",
  "cwd",
]);

const URL_KEYS = new Set(["url", "uri", "href", "endpoint", "host", "hostname"]);

const TRAVERSAL = /(?:^|[\\/])\.\.(?:[\\/]|$)/;
const SECRET_FILE =
  /(?:^|[\\/])(?:\.env(?:\.[A-Za-z0-9._-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519|authorized_keys)(?:$|[\\/])/i;
const UNIX_EXFIL =
  /(?:^|[\\/])(?:etc[\\/](?:passwd|shadow|sudoers)|proc[\\/]self[\\/]environ|\.ssh[\\/]|\.aws[\\/])/i;
const METADATA_HOST =
  /169\.254\.169\.254|metadata\.google\.internal|metadata\.internal|fd00:ec2::254/i;
const FILE_SCHEME = /^file:/i;

const READ_OR_FETCH =
  /\b(?:cat|less|more|head|tail|nl|od|xxd|hexdump|strings|curl|wget|scp|rsync|grep|egrep|fgrep|awk|sed|cut|sort|uniq|rg|bat|dd)\b/i;
const WRITE_VERB = /\b(?:cp|mv|tee|install|chmod|chown|chattr|ln|dd)\b/i;
const REDIRECT_TO_SECRET =
  /(?:^|[\s;|&])(?:>>?|2>>?|&>>?)\s*(?:["']?)(?:~\/|\/)?(?:etc[\\/](?:passwd|shadow|sudoers)|(?:\.\.\/)*\.env(?:\.[A-Za-z0-9._-]+)?|\.npmrc|\.netrc|\.ssh|\.aws|id_rsa|id_ed25519|authorized_keys)/i;
const INTERPRETER_EVAL =
  /\b(?:python3?|node(?:js)?|ruby|perl|php)\b[\s\S]{0,120}(?:\s-[ce]\b|\bopen\s*\(|\breadFile(?:Sync)?\s*\(|\brequire\s*\(|\bFile\.open\s*\()/i;
const FILE_IN_COMMAND = /\bfile:\/\//i;

export interface TargetHit {
  key: string;
  kind: "path" | "url";
  value: string;
}

export function collectTargetFields(value: unknown, depth = 0): TargetHit[] {
  if (depth > 6 || value == null) return [];
  if (typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTargetFields(item, depth + 1));
  }
  const hits: TargetHit[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (typeof child === "string") {
      if (PATH_KEYS.has(lower)) hits.push({ key, kind: "path", value: child });
      if (URL_KEYS.has(lower)) hits.push({ key, kind: "url", value: child });
    } else {
      hits.push(...collectTargetFields(child, depth + 1));
    }
  }
  return hits;
}

export function localTargetBlock(value: "exfil" | "ssrf" = "exfil"): PolicyDecision {
  return { action: "block", value, reason: "target-local", node: "tool_bind" };
}

export function classifyCommandTarget(command: string): PolicyDecision | null {
  if (!command) return null;
  if (METADATA_HOST.test(command) || FILE_IN_COMMAND.test(command)) {
    return localTargetBlock("ssrf");
  }
  const readsSecret = UNIX_EXFIL.test(command) || SECRET_FILE.test(command);
  if (readsSecret && (READ_OR_FETCH.test(command) || WRITE_VERB.test(command))) {
    return localTargetBlock("exfil");
  }
  if (REDIRECT_TO_SECRET.test(command)) {
    return localTargetBlock("exfil");
  }
  if (INTERPRETER_EVAL.test(command) && readsSecret) {
    return localTargetBlock("exfil");
  }
  return null;
}

export function localTargetDecision(args: unknown): PolicyDecision | null {
  for (const hit of collectTargetFields(args)) {
    if (hit.kind === "path") {
      if (TRAVERSAL.test(hit.value) || SECRET_FILE.test(hit.value) || UNIX_EXFIL.test(hit.value)) {
        return localTargetBlock("exfil");
      }
    }
    if (hit.kind === "url") {
      if (METADATA_HOST.test(hit.value) || FILE_SCHEME.test(hit.value)) {
        return localTargetBlock("ssrf");
      }
      if (TRAVERSAL.test(hit.value) || UNIX_EXFIL.test(hit.value) || SECRET_FILE.test(hit.value)) {
        return localTargetBlock("exfil");
      }
    }
  }
  return classifyCommandTarget(commandFromToolArgs(args));
}
