import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { isAbsolute, normalize } from "node:path";

export interface WorkAuditScope { goalId: string; profile: string; root: string }
export interface WorkAuditPoint { sequence: number; hash: string }
export interface WorkAuditHead extends WorkAuditPoint { scope: WorkAuditScope }
export interface WorkAuditActor { kind: "user" | "worker" | "system"; id: string }
export interface WorkAuditMetadata {
  status?: "draft" | "queued" | "running" | "completed" | "failed" | "interrupted" | "cancelled" | "needs_review" | "budget_exhausted";
  reasonCode?: string;
  taskCount?: number;
  tokens?: number;
  reservedTokens?: number;
}
export interface WorkAuditAppend {
  scope: WorkAuditScope; transitionId: string; actor: WorkAuditActor; kind: string;
  taskId?: string; attemptId?: string; at: number; revision: number;
  /** Undefined only for the first event. Bodies are hashed, never persisted. */
  before?: unknown; after: unknown; metadata?: WorkAuditMetadata;
}
export interface WorkAuditEvent {
  version: 1; scope: WorkAuditScope; sequence: number; transitionId: string;
  actor: WorkAuditActor; kind: string; taskId: string | null; attemptId: string | null;
  at: number; revision: number; beforeHash: string | null; afterHash: string;
  metadata: WorkAuditMetadata; previousHash: string; hash: string;
}
export interface WorkAuditExport {
  schema: "hades.work-audit.v1"; scope: WorkAuditScope; predecessor: WorkAuditPoint;
  events: WorkAuditEvent[]; end: WorkAuditPoint; head: WorkAuditPoint; hasMore: boolean;
}
export class WorkAuditError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = "WorkAuditError"; }
}
function fail(code: string, message: string): never { throw new WorkAuditError(code, message); }
export const WORK_AUDIT_GENESIS = "0".repeat(64);
const MAX_PAGE = 500;
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
const MAX_EXPORT_BYTES = 1024 * 1024;
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid_data", "Expected a plain object");
  return value as Record<string, unknown>;
};
function keys(value: unknown, allowed: string[]) {
  const v = object(value);
  if (Object.keys(v).some(k => !allowed.includes(k))) fail("invalid_data", "Unexpected audit field");
  return v;
}
function id(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)) fail("invalid_data", `Invalid ${name}`);
  return value as string;
}
function integer(value: unknown, name: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) fail("invalid_data", `Invalid ${name}`);
  return value as number;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail("invalid_data", "Invalid audit hash");
  return value as string;
}
function scope(value: unknown): WorkAuditScope {
  const s = keys(value, ["goalId", "profile", "root"]);
  if (typeof s.root !== "string" || !isAbsolute(s.root) || normalize(s.root) !== s.root || s.root.length > 4096 || /[\u0000-\u001f]/.test(s.root)) fail("invalid_scope", "Audit root must be an absolute normalized path");
  return { goalId: id(s.goalId, "goal"), profile: id(s.profile, "profile"), root: s.root as string };
}
function sameScope(a: WorkAuditScope, b: WorkAuditScope) {
  if (a.goalId !== b.goalId || a.profile !== b.profile || a.root !== b.root) fail("scope_mismatch", "Audit goal, profile or root does not match");
}
/** Deterministic JSON: sorted object keys, no accessors/toJSON, no non-finite values.
 * Optional undefined object fields are omitted like JSON.stringify; array holes are refused. */
function canonical(value: unknown, limit: number, maxNodes = 100000): string {
  const seen = new Set<object>(); let nodes = 0; let bytes = 0;
  const encode = (v: unknown, depth: number): string => {
    if (++nodes > maxNodes || depth > 40) fail("oversized", "Audit value exceeds structural bounds");
    if (v === null || typeof v === "boolean" || typeof v === "string" || typeof v === "number") {
      if (typeof v === "number" && !Number.isFinite(v)) fail("invalid_data", "Non-finite audit number");
      const text = JSON.stringify(v); bytes += Buffer.byteLength(text);
      if (bytes > limit) fail("oversized", "Audit value exceeds byte limit");
      return text;
    }
    if (!v || typeof v !== "object") fail("invalid_data", "Audit value must be JSON data");
    if (seen.has(v as object)) fail("invalid_data", "Cyclic audit value");
    seen.add(v as object); let text: string;
    if (Array.isArray(v)) {
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !("value" in d)) fail("invalid_data", "Sparse or accessor audit array");
        items.push(encode(d.value, depth + 1));
      }
      text = `[${items.join(",")}]`;
    } else {
      const obj = object(v); const items: string[] = [];
      for (const k of Object.keys(obj).sort()) {
        const d = Object.getOwnPropertyDescriptor(obj, k)!;
        if (!("value" in d)) fail("invalid_data", "Audit accessors are unsupported");
        if (d.value !== undefined) { bytes += Buffer.byteLength(JSON.stringify(k)) + 1; items.push(`${JSON.stringify(k)}:${encode(d.value, depth + 1)}`); }
      }
      text = `{${items.join(",")}}`;
    }
    seen.delete(v as object);
    if (Buffer.byteLength(text) > limit) fail("oversized", "Audit value exceeds byte limit");
    return text;
  };
  return encode(value, 0);
}
export function hashWorkAuditSnapshot(value: unknown): string { return digest(canonical(value, MAX_SNAPSHOT_BYTES)); }
function snapshot(value: unknown, s: WorkAuditScope): string {
  const bodyHash = hashWorkAuditSnapshot(value);
  const v = object(value); sameScope(s, scope({ goalId: v.id, profile: v.profile, root: v.root }));
  return bodyHash;
}
function metadata(value: unknown): WorkAuditMetadata {
  const m = keys(value ?? {}, ["status", "reasonCode", "taskCount", "tokens", "reservedTokens"]);
  const result: WorkAuditMetadata = {};
  if (m.status !== undefined) {
    if (!["draft", "queued", "running", "completed", "failed", "interrupted", "cancelled", "needs_review", "budget_exhausted"].includes(String(m.status))) fail("invalid_data", "Invalid audit status");
    result.status = m.status as WorkAuditMetadata["status"];
  }
  if (m.reasonCode !== undefined) result.reasonCode = id(m.reasonCode, "reason code");
  for (const k of ["taskCount", "tokens", "reservedTokens"] as const) if (m[k] !== undefined) result[k] = integer(m[k], k);
  canonical(result, 1024); return result;
}
function actor(value: unknown): WorkAuditActor {
  const a = keys(value, ["kind", "id"]);
  if (!["user", "worker", "system"].includes(String(a.kind))) fail("invalid_data", "Invalid audit actor kind");
  return { kind: a.kind as WorkAuditActor["kind"], id: id(a.id, "actor") };
}
function point(value: unknown): WorkAuditPoint {
  const p = keys(value, ["sequence", "hash"]); const sequence = integer(p.sequence, "sequence"); const h = hash(p.hash);
  if (sequence === 0 && h !== WORK_AUDIT_GENESIS) fail("chain_mismatch", "Invalid genesis hash");
  return { sequence, hash: h };
}
function event(value: unknown): WorkAuditEvent {
  const e = keys(value, ["version", "scope", "sequence", "transitionId", "actor", "kind", "taskId", "attemptId", "at", "revision", "beforeHash", "afterHash", "metadata", "previousHash", "hash"]);
  if (e.version !== 1) fail("invalid_data", "Unsupported audit event version");
  const parsed: WorkAuditEvent = {
    version: 1, scope: scope(e.scope), sequence: integer(e.sequence, "sequence", 1), transitionId: id(e.transitionId, "transition"),
    actor: actor(e.actor), kind: id(e.kind, "kind"), taskId: e.taskId === null ? null : id(e.taskId, "task"), attemptId: e.attemptId === null ? null : id(e.attemptId, "attempt"),
    at: integer(e.at, "time"), revision: integer(e.revision, "revision"), beforeHash: e.beforeHash === null ? null : hash(e.beforeHash), afterHash: hash(e.afterHash),
    metadata: metadata(e.metadata), previousHash: hash(e.previousHash), hash: hash(e.hash),
  };
  const { hash: h, ...body } = parsed;
  if (digest(canonical(body, 16384)) !== h) fail("chain_mismatch", "Audit event hash does not match its contents");
  return parsed;
}
/** A partial page cannot authenticate against a later head. To verify a suffix,
 * independently supply its predecessor; by default verification starts at genesis. */
export function verifyWorkAuditExport(value: unknown, expected: { scope: WorkAuditScope; head: WorkAuditPoint; predecessor?: WorkAuditPoint }): WorkAuditHead {
  canonical(value, MAX_EXPORT_BYTES);
  const x = keys(value, ["schema", "scope", "predecessor", "events", "end", "head", "hasMore"]);
  if (x.schema !== "hades.work-audit.v1" || !Array.isArray(x.events) || x.events.length > MAX_PAGE || typeof x.hasMore !== "boolean") fail("invalid_data", "Invalid audit export");
  const s = scope(x.scope); sameScope(s, scope(expected.scope));
  const start = point(x.predecessor), anchor = point(expected.predecessor ?? { sequence: 0, hash: WORK_AUDIT_GENESIS });
  if (start.sequence !== anchor.sequence || start.hash !== anchor.hash) fail("chain_mismatch", "Audit predecessor does not match expected anchor");
  let cursor = start; let previous: WorkAuditEvent | undefined; const transitions = new Set<string>();
  for (const raw of x.events) {
    const e = event(raw); sameScope(s, e.scope);
    if (e.sequence !== cursor.sequence + 1 || e.previousHash !== cursor.hash) fail("chain_mismatch", "Missing or reordered audit event");
    if (e.sequence === 1 && e.beforeHash !== null || e.sequence > 1 && e.beforeHash === null) fail("chain_mismatch", "Invalid snapshot genesis");
    if (previous && (e.beforeHash !== previous.afterHash || e.revision <= previous.revision)) fail("chain_mismatch", "Audit snapshot or revision continuity failed");
    if (transitions.has(e.transitionId)) fail("duplicate_transition", "Repeated source transition");
    transitions.add(e.transitionId); previous = e; cursor = { sequence: e.sequence, hash: e.hash };
  }
  const end = point(x.end), claimedHead = point(x.head), head = point({sequence:expected.head.sequence,hash:expected.head.hash});
  if (cursor.sequence !== end.sequence || cursor.hash !== end.hash) fail("chain_mismatch", "Audit export end does not match its events");
  if (x.hasMore || end.sequence !== head.sequence || end.hash !== head.hash || claimedHead.sequence !== head.sequence || claimedHead.hash !== head.hash) fail("head_mismatch", "Audit export does not reach the independently expected head");
  return { scope: s, ...head };
}
interface Row { goal_id: string; sequence: number; transition_id: string; revision: number; previous_hash: string; before_hash: string | null; after_hash: string; event_hash: string; event_json: string }
function storedEvent(row: Row): WorkAuditEvent {
  if (typeof row.event_json !== "string" || Buffer.byteLength(row.event_json) > 16384) fail("oversized", "Stored audit event exceeds byte limit");
  let raw: unknown;
  try { raw = JSON.parse(row.event_json); } catch { fail("invalid_data", "Stored audit event is not valid JSON"); }
  const e = event(raw);
  if (row.goal_id !== e.scope.goalId || row.sequence !== e.sequence || row.transition_id !== e.transitionId || row.revision !== e.revision || row.previous_hash !== e.previousHash || row.before_hash !== e.beforeHash || row.after_hash !== e.afterHash || row.event_hash !== e.hash) fail("chain_mismatch", "Audit row fields do not match its canonical event");
  return e;
}
/** Caller owns database lifetime and authoritative mutation transactions. */
export class WorkAuditJournal {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_audit_scopes(goal_id TEXT PRIMARY KEY, profile TEXT NOT NULL, root TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS work_audit_events(goal_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
        transition_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), previous_hash TEXT NOT NULL,
        before_hash TEXT, after_hash TEXT NOT NULL, event_hash TEXT NOT NULL, event_json TEXT NOT NULL,
        PRIMARY KEY(goal_id,sequence), UNIQUE(goal_id,transition_id), UNIQUE(goal_id,revision));
      CREATE TRIGGER IF NOT EXISTS work_audit_no_update BEFORE UPDATE ON work_audit_events BEGIN SELECT RAISE(ABORT,'work audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS work_audit_no_delete BEFORE DELETE ON work_audit_events BEGIN SELECT RAISE(ABORT,'work audit is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS work_audit_scope_no_replace BEFORE INSERT ON work_audit_scopes WHEN EXISTS(SELECT 1 FROM work_audit_scopes WHERE goal_id=NEW.goal_id) BEGIN SELECT RAISE(ABORT,'work audit scope already exists'); END;
      CREATE TRIGGER IF NOT EXISTS work_audit_scope_no_update BEFORE UPDATE ON work_audit_scopes BEGIN SELECT RAISE(ABORT,'work audit scope is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS work_audit_scope_no_delete BEFORE DELETE ON work_audit_scopes BEGIN SELECT RAISE(ABORT,'work audit scope is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS work_audit_insert BEFORE INSERT ON work_audit_events BEGIN
        SELECT CASE WHEN EXISTS(SELECT 1 FROM work_audit_events WHERE goal_id=NEW.goal_id AND (transition_id=NEW.transition_id OR revision=NEW.revision)) THEN RAISE(ABORT,'work audit duplicate transition or revision') END;
        SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM work_audit_scopes WHERE goal_id=NEW.goal_id) THEN RAISE(ABORT,'work audit scope missing') END;
        SELECT CASE WHEN json_valid(NEW.event_json)!=1 THEN RAISE(ABORT,'work audit invalid JSON') END;
        SELECT CASE WHEN json_extract(NEW.event_json,'$.scope.goalId') IS NOT NEW.goal_id OR json_extract(NEW.event_json,'$.scope.profile') IS NOT (SELECT profile FROM work_audit_scopes WHERE goal_id=NEW.goal_id) OR json_extract(NEW.event_json,'$.scope.root') IS NOT (SELECT root FROM work_audit_scopes WHERE goal_id=NEW.goal_id) OR json_extract(NEW.event_json,'$.sequence') IS NOT NEW.sequence OR json_extract(NEW.event_json,'$.revision') IS NOT NEW.revision OR json_extract(NEW.event_json,'$.transitionId') IS NOT NEW.transition_id OR json_extract(NEW.event_json,'$.previousHash') IS NOT NEW.previous_hash OR json_extract(NEW.event_json,'$.beforeHash') IS NOT NEW.before_hash OR json_extract(NEW.event_json,'$.afterHash') IS NOT NEW.after_hash OR json_extract(NEW.event_json,'$.hash') IS NOT NEW.event_hash THEN RAISE(ABORT,'work audit event fields mismatch') END;
        SELECT CASE WHEN NEW.sequence != COALESCE((SELECT MAX(sequence) FROM work_audit_events WHERE goal_id=NEW.goal_id),0)+1 THEN RAISE(ABORT,'work audit sequence mismatch') END;
        SELECT CASE WHEN NEW.previous_hash != COALESCE((SELECT event_hash FROM work_audit_events WHERE goal_id=NEW.goal_id ORDER BY sequence DESC LIMIT 1),'${WORK_AUDIT_GENESIS}') THEN RAISE(ABORT,'work audit predecessor mismatch') END;
        SELECT CASE WHEN NEW.sequence=1 AND NEW.before_hash IS NOT NULL OR NEW.sequence>1 AND (NEW.before_hash IS NULL OR NEW.before_hash != (SELECT after_hash FROM work_audit_events WHERE goal_id=NEW.goal_id ORDER BY sequence DESC LIMIT 1)) THEN RAISE(ABORT,'work audit snapshot mismatch') END;
        SELECT CASE WHEN NEW.revision <= COALESCE((SELECT MAX(revision) FROM work_audit_events WHERE goal_id=NEW.goal_id),-1) THEN RAISE(ABORT,'work audit revision mismatch') END;
      END;`);
  }
  private checkedScope(value: WorkAuditScope): WorkAuditScope {
    const s = scope(value); const row = this.db.prepare("SELECT profile,root FROM work_audit_scopes WHERE goal_id=?").get(s.goalId) as {profile:string;root:string} | undefined;
    if (row) sameScope(s, {goalId:s.goalId,...row});
    return s;
  }
  private at(s: WorkAuditScope, sequence: number): WorkAuditPoint {
    if (!sequence) return {sequence:0,hash:WORK_AUDIT_GENESIS};
    const row = this.db.prepare("SELECT * FROM work_audit_events WHERE goal_id=? AND sequence=?").get(s.goalId, sequence) as Row | undefined;
    if (!row) fail("missing_event", "Audit cursor event is missing");
    const e = storedEvent(row); sameScope(s,e.scope);
    if (e.sequence !== row.sequence) fail("chain_mismatch", "Audit row sequence mismatch");
    return {sequence:e.sequence,hash:e.hash};
  }
  head(value: WorkAuditScope): WorkAuditHead {
    const s = this.checkedScope(value); const row = this.db.prepare("SELECT MAX(sequence) AS sequence FROM work_audit_events WHERE goal_id=?").get(s.goalId) as {sequence:number|null};
    return {scope:s,...this.at(s,row.sequence ?? 0)};
  }
  append(input: WorkAuditAppend): WorkAuditEvent {
    const s = this.checkedScope(input.scope); const beforeHash = input.before === undefined ? null : snapshot(input.before,s); const afterHash = snapshot(input.after,s);
    const base = {version:1 as const,scope:s,transitionId:id(input.transitionId,"transition"),actor:actor(input.actor),kind:id(input.kind,"kind"),taskId:input.taskId === undefined ? null : id(input.taskId,"task"),attemptId:input.attemptId === undefined ? null : id(input.attemptId,"attempt"),at:integer(input.at,"time"),revision:integer(input.revision,"revision"),beforeHash,afterHash,metadata:metadata(input.metadata)};
    const savepoint = `audit_${randomUUID().replaceAll("-", "")}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      this.checkedScope(s);
      if (!this.db.prepare("SELECT 1 FROM work_audit_scopes WHERE goal_id=?").get(s.goalId)) this.db.prepare("INSERT INTO work_audit_scopes(goal_id,profile,root) VALUES(?,?,?)").run(s.goalId,s.profile,s.root);
      if (this.db.prepare("SELECT 1 FROM work_audit_events WHERE goal_id=? AND transition_id=?").get(s.goalId,base.transitionId)) fail("duplicate_transition","Source transition was already audited");
      const head = this.head(s); const row = head.sequence ? this.db.prepare("SELECT * FROM work_audit_events WHERE goal_id=? AND sequence=?").get(s.goalId,head.sequence) as unknown as Row : null;
      const previous = row ? storedEvent(row) : null;
      if (previous ? beforeHash !== previous.afterHash : beforeHash !== null) fail("snapshot_mismatch","Before snapshot does not match the audited goal");
      if (previous && base.revision <= previous.revision) fail("revision_mismatch","Audit revision must increase");
      const body = {...base,sequence:integer(head.sequence+1,"sequence",1),previousHash:head.hash}; const e: WorkAuditEvent = {...body,hash:digest(canonical(body,16384))};
      this.db.prepare("INSERT INTO work_audit_events(goal_id,sequence,transition_id,revision,previous_hash,before_hash,after_hash,event_hash,event_json) VALUES(?,?,?,?,?,?,?,?,?)").run(s.goalId,e.sequence,e.transitionId,e.revision,e.previousHash,e.beforeHash,e.afterHash,e.hash,canonical(e,16384));
      this.db.exec(`RELEASE ${savepoint}`); return e;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  read(value: WorkAuditScope, options: {afterSequence?:number;limit?:number;expectedHead?:WorkAuditHead} = {}): WorkAuditExport {
    const s = this.checkedScope(value); const after = integer(options.afterSequence ?? 0,"cursor"); const limit = integer(options.limit ?? 100,"limit",1);
    if (limit > MAX_PAGE) fail("oversized","Audit page limit is 500 events");
    const actual = this.head(s); const expected = options.expectedHead;
    if (expected) sameScope(s,scope(expected.scope));
    const head = expected ? point({sequence:expected.sequence,hash:expected.hash}) : {sequence:actual.sequence,hash:actual.hash};
    if (head.sequence > actual.sequence || this.at(s,head.sequence).hash !== head.hash) fail("head_mismatch","Frozen audit head is unavailable or changed");
    if (after > head.sequence) fail("invalid_cursor","Audit cursor is beyond the frozen head");
    const predecessor = this.at(s,after);
    const rows = this.db.prepare("SELECT * FROM work_audit_events WHERE goal_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?").all(s.goalId,after,head.sequence,limit) as unknown as Row[];
    const events = rows.map(row => {const e=storedEvent(row); if(e.sequence!==row.sequence) fail("chain_mismatch","Audit row sequence mismatch"); return e;});
    const last = events.at(-1); const end = last ? {sequence:last.sequence,hash:last.hash} : predecessor;
    if (events.length !== Math.min(limit,head.sequence-after)) fail("missing_event","Audit page has missing events");
    const result: WorkAuditExport = {schema:"hades.work-audit.v1",scope:s,predecessor,events,end,head,hasMore:end.sequence<head.sequence};
    verifyWorkAuditExport({...result,head:end,hasMore:false},{scope:s,head:end,predecessor});
    canonical(result,MAX_EXPORT_BYTES); return result;
  }
  export(value: WorkAuditScope, options?: {afterSequence?:number;limit?:number;expectedHead?:WorkAuditHead}): WorkAuditExport { return this.read(value,options); }
}


export interface WorkAuditBundle {
  schema: "hades.work-audit-bundle.v1";
  scope: WorkAuditScope;
  head: WorkAuditPoint | WorkAuditHead;
  pages: WorkAuditExport[];
}
/** Full genesis-to-head verification, bounded to ten pages / 5000 events / 8 MiB. */
export function verifyWorkAuditBundle(value: unknown, expected: {scope: WorkAuditScope; head: WorkAuditPoint}): WorkAuditHead {
  canonical(value, 8 * 1024 * 1024, 500000);
  const bundle = keys(value, ["schema", "scope", "head", "pages"]);
  if (bundle.schema !== "hades.work-audit-bundle.v1" || !Array.isArray(bundle.pages) || bundle.pages.length < 1 || bundle.pages.length > 10) fail("invalid_data", "Audit bundle requires one to ten pages");
  const s = scope(bundle.scope); sameScope(s, scope(expected.scope));
  const declared = keys(bundle.head, ["scope", "sequence", "hash"]);
  if (declared.scope !== undefined) sameScope(s, scope(declared.scope));
  const head = point({sequence:expected.head.sequence,hash:expected.head.hash});
  if (declared.sequence !== head.sequence || declared.hash !== head.hash) fail("head_mismatch", "Audit bundle head differs from independently expected head");
  let predecessor: WorkAuditPoint = {sequence:0,hash:WORK_AUDIT_GENESIS};
  let previous: WorkAuditEvent | undefined; const transitions = new Set<string>();
  for (const [index, raw] of bundle.pages.entries()) {
    const page = keys(raw, ["schema", "scope", "predecessor", "events", "end", "head", "hasMore"]);
    const pageHead = point(page.head), end = point(page.end);
    if (pageHead.sequence !== head.sequence || pageHead.hash !== head.hash || end.sequence > head.sequence) fail("head_mismatch", "Audit page does not use the frozen bundle head");
    if (page.hasMore !== (end.sequence < head.sequence)) fail("head_mismatch", "Audit page continuation flag contradicts frozen head");
    if (!Array.isArray(page.events) || (!page.events.length && (head.sequence !== 0 || bundle.pages.length !== 1))) fail("missing_event", "Audit bundle contains an empty non-genesis page");
    verifyWorkAuditExport({...page,head:end,hasMore:false},{scope:s,head:end,predecessor});
    for (const rawEvent of page.events) {
      const e = rawEvent as WorkAuditEvent; // validated above, no task/source code is executed
      if (previous && (previous.afterHash !== e.beforeHash || e.revision <= previous.revision)) fail("chain_mismatch", "Audit continuity failed at bundle boundary");
      if (transitions.has(e.transitionId)) fail("duplicate_transition", "Repeated source transition in bundle");
      transitions.add(e.transitionId); previous = e;
    }
    predecessor = end;
    if (index < bundle.pages.length - 1 && end.sequence === head.sequence) fail("head_mismatch", "Audit bundle has pages after its terminal head");
  }
  if (predecessor.sequence !== head.sequence || predecessor.hash !== head.hash) fail("head_mismatch", "Audit bundle omits its final events or pages");
  return {scope:s,...head};
}
