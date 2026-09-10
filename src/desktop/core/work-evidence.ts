import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

export interface WorkOutputCheck { path: string; contains?: string }
export interface WorkOutputEvidence { path: string; sha256: string; bytes: number }

export function workPath(root: string, value: unknown, allowRoot = false): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\x00-\x1f\\*?\[\]{}]/.test(value)) throw new Error("Choose a project-relative path without wildcards");
  const path = value.trim();
  if (isAbsolute(path) || /^[a-z]:/i.test(path) || path.split("/").includes("..")) throw new Error("Paths must stay inside the project");
  const rel = relative(root, resolve(root, path));
  if ((!rel && !allowRoot) || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Paths must stay inside the project");
  let target = root;
  for (const part of rel.split("/").filter(Boolean)) {
    target = join(target, part);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw new Error("Work paths cannot follow symbolic links");
  }
  return rel || ".";
}

export function workChecks(root: string, value: unknown): WorkOutputCheck[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("Choose up to 32 output checks");
  return value.map(check => {
    if (!check || typeof check !== "object") throw new Error("Invalid output check");
    const path = workPath(root, check.path);
    if (check.contains !== undefined && (typeof check.contains !== "string" || !check.contains.trim() || check.contains.length > 8000)) throw new Error("Invalid expected text");
    return { path, ...(check.contains === undefined ? {} : { contains: check.contains.trim() }) };
  });
}

export function workWrites(root: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) throw new Error("Choose up to 32 declared edit paths");
  return [...new Set(value.map(path => workPath(root, path, true)))];
}

/** Edit reservations coordinate cooperative tasks. They are not an OS sandbox.
 * Undeclared legacy tasks conservatively reserve the entire project. */
export function workWritesOverlap(a?: string[], b?: string[]): boolean {
  return (a ?? ["."]).some(left => (b ?? ["."]).some(right => {
    const x = left.normalize("NFC").toLowerCase(), y = right.normalize("NFC").toLowerCase();
    return x === "." || y === "." || x === y || x.startsWith(y + "/") || y.startsWith(x + "/");
  }));
}

export function workPlanWritesOverlap(leftRoot: string, left?: string[], rightRoot = leftRoot, right?: string[]): boolean {
  return workWritesOverlap((left ?? ["."]).map(path => resolve(leftRoot, path)), (right ?? ["."]).map(path => resolve(rightRoot, path)));
}

export function verifyWorkOutputs(root: string, checks: WorkOutputCheck[]): WorkOutputEvidence[] {
  return checks.map(check => {
    const path = workPath(root, check.path);
    const actual = realpathSync(join(root, path));
    const rel = relative(root, actual);
    if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("Output escaped the project");
    const stat = lstatSync(actual);
    if (!stat.isFile() || stat.size > 2000000) throw new Error("Expected a regular output file of at most 2 MB");
    const bytes = readFileSync(actual);
    if (check.contains !== undefined && !bytes.toString("utf8").includes(check.contains)) throw new Error(`Output ${path} is missing the expected text`);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  });
}

export function assertWorkEvidence(root: string, checks: WorkOutputCheck[], evidence?: WorkOutputEvidence[]): void {
  if (!checks.length) return;
  const fresh = verifyWorkOutputs(root, checks);
  if (!evidence || JSON.stringify(fresh) !== JSON.stringify(evidence)) throw new Error("Task evidence changed. Inspect the changed outputs and revise the producing task before continuing.");
}
