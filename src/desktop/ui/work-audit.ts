import "./work-audit.css";

type Rpc = (method: string, args: Record<string, unknown>) => Promise<unknown>;
export interface AuditScope {
  goalId: string;
  profile: string;
  root: string;
}
interface Point {
  sequence: number;
  hash: string;
}
interface Head extends Point {
  scope: AuditScope;
}
interface AuditEvent {
  sequence: number;
  scope: AuditScope;
  kind: string;
  at: number;
  revision: number;
  taskId: string | null;
  attemptId: string | null;
  actor: { kind: string; id: string };
  metadata: { status?: string };
  hash: string;
  previousHash: string;
  beforeHash: string | null;
  afterHash: string;
}
interface Page {
  schema: string;
  scope: AuditScope;
  predecessor: Point;
  events: AuditEvent[];
  end: Point;
  head: Point;
  hasMore: boolean;
}
const zero = "0".repeat(64);
const record = (v: unknown): Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("History response is invalid.");
  return v as Record<string, unknown>;
};
const text = (v: unknown, max = 160): string => {
  if (typeof v !== "string" || v.length > max)
    throw new Error("History response contains an invalid field.");
  return v;
};
const integer = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
    throw new Error("History response contains an invalid number.");
  return v;
};
const hash = (v: unknown): string => {
  const h = text(v, 64);
  if (!/^[a-f0-9]{64}$/.test(h))
    throw new Error(
      "History response contains an invalid integrity reference.",
    );
  return h;
};
const point = (v: unknown): Point => {
  const p = record(v);
  const n = integer(p.sequence),
    h = hash(p.hash);
  if (n === 0 && h !== zero)
    throw new Error("History genesis reference is invalid.");
  return { sequence: n, hash: h };
};
function checkScope(value: unknown, expected: AuditScope): AuditScope {
  const s = record(value);
  if (
    s.goalId !== expected.goalId ||
    s.profile !== expected.profile ||
    s.root !== expected.root
  )
    throw new Error(
      "History belongs to a different goal or profile. Refresh to try again.",
    );
  return { ...expected };
}
function head(value: unknown, s: AuditScope): Head {
  const h = record(value);
  return { ...point(h), scope: checkScope(h.scope, s) };
}
function same(a: Point, b: Point) {
  return a.sequence === b.sequence && a.hash === b.hash;
}
function page(
  value: unknown,
  s: AuditScope,
  expected: Point,
  predecessor: Point,
  max = 100,
): Page {
  const p = record(value);
  checkScope(p.scope, s);
  if (
    p.schema !== "hades.work-audit.v1" ||
    !Array.isArray(p.events) ||
    p.events.length > max ||
    typeof p.hasMore !== "boolean"
  )
    throw new Error("History page is invalid.");
  const start = point(p.predecessor),
    end = point(p.end),
    h = point(p.head);
  if (!same(start, predecessor) || !same(h, expected))
    throw new Error("History changed while loading. Refresh to try again.");
  let cursor = start;
  const events = p.events.map((raw) => {
    const e = record(raw),
      a = record(e.actor),
      m = record(e.metadata);
    checkScope(e.scope, s);
    const item: AuditEvent = {
      scope: { ...s },
      sequence: integer(e.sequence),
      kind: text(e.kind),
      at: integer(e.at),
      revision: integer(e.revision),
      taskId: e.taskId === null ? null : text(e.taskId),
      attemptId: e.attemptId === null ? null : text(e.attemptId),
      actor: { kind: text(a.kind), id: text(a.id) },
      metadata: m.status === undefined ? {} : { status: text(m.status) },
      hash: hash(e.hash),
      previousHash: hash(e.previousHash),
      beforeHash: e.beforeHash === null ? null : hash(e.beforeHash),
      afterHash: hash(e.afterHash),
    };
    if (
      item.sequence !== cursor.sequence + 1 ||
      item.previousHash !== cursor.hash
    )
      throw new Error("History page is incomplete. Refresh to try again.");
    cursor = { sequence: item.sequence, hash: item.hash };
    return item;
  });
  if (
    !same(cursor, end) ||
    end.sequence > h.sequence ||
    p.hasMore !== end.sequence < h.sequence ||
    (!events.length && end.sequence < h.sequence)
  )
    throw new Error("History page is incomplete. Refresh to try again.");
  return {
    schema: p.schema,
    scope: { ...s },
    predecessor: start,
    events,
    end,
    head: h,
    hasMore: p.hasMore,
  };
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  content?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (content !== undefined) el.textContent = content;
  if (className) el.className = className;
  return el;
}
const labels: Record<string, string> = {
  "work.baseline": "History started",
  "work.created": "Work created",
  "work.updated": "Work updated",
  "goal.created": "Work created",
  "goal.updated": "Work updated",
  draft: "Draft",
  running: "Working",
  completed: "Completed",
  needs_review: "Needs review",
  cancelled: "Stopped",
  interrupted: "Interrupted",
  budget_exhausted: "Budget reached",
  failed: "Failed",
  queued: "Waiting",
};
const label = (value: string) =>
  labels[value] ??
  value.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase());
export function downloadWorkAudit(name: string, content: string): void {
  const a = document.createElement("a");
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  a.href = url;
  a.download = name;
  try {
    a.click();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
/** Persistent DOM subtree: shell rerenders reattach it without resetting disclosure,
 * loaded pages, native text selection or keyboard focus. No history polling. */
export class WorkAuditView {
  readonly element = node("details", undefined, "work-audit");
  private summary = node("summary", "Activity history");
  private status = node("p", "", "work-audit-status");
  private list = node("ol", undefined, "work-audit-list");
  private refreshButton = node("button", "Refresh");
  private exportButton = node("button", "Export history");
  private moreButton = node("button", "Load more");
  private integrity = node("p", undefined, "work-audit-integrity");
  private frozen?: Head;
  private end: Point = { sequence: 0, hash: zero };
  private count = 0;
  private loaded = false;
  private loading = false;
  private exporting = false;
  private generation = 0;
  private mounted = false;
  private observer?: MutationObserver;
  private focused?: HTMLElement;
  private selection?: Range;
  disposed = false;
  constructor(
    private rpc: Rpc,
    readonly scope: AuditScope,
    private download = downloadWorkAudit,
  ) {
    this.scope = { ...scope };
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(scope.goalId))
      throw new Error("Invalid history goal.");
    const content = node("div", undefined, "work-audit-content"),
      actions = node("div", undefined, "work-audit-actions");
    for (const b of [this.refreshButton, this.exportButton, this.moreButton]) {
      b.type = "button";
      actions.append(b);
    }
    this.refreshButton.onclick = () => void this.load(true);
    this.moreButton.onclick = () => void this.load(false);
    this.exportButton.onclick = () => void this.export();
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.list.setAttribute("aria-label", "Recorded work activity");
    const advanced = node("details", undefined, "work-audit-advanced");
    advanced.append(
      node("summary", "About this history"),
      node(
        "p",
        "Recorded locally; export preserves state changes, not original prompt contents. Integrity hashes do not verify who changed the database.",
      ),
      this.integrity,
    );
    content.append(actions, this.status, this.list, advanced);
    this.element.append(this.summary, content);
    this.element.addEventListener("toggle", () => {
      if (this.element.open && !this.loaded && !this.loading && !this.disposed)
        void this.load(true);
    });
    this.updateControls();
  }
  matches(s: AuditScope) {
    return (
      !this.disposed &&
      s.goalId === this.scope.goalId &&
      s.profile === this.scope.profile &&
      s.root === this.scope.root
    );
  }
  captureViewState() {
    this.focused = this.element.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : undefined;
    const selection = document.getSelection();
    this.selection =
      selection?.rangeCount && this.element.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : undefined;
  }
  mount(host: HTMLElement) {
    if (this.disposed) return;
    host.append(this.element);
    this.mounted = true;
    this.focused?.focus({ preventScroll: true });
    this.focused = undefined;
    if (this.selection) {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(this.selection);
      this.selection = undefined;
    }
    if (!this.observer) {
      this.observer = new MutationObserver(() => {
        if (this.mounted && !this.element.isConnected) this.dispose();
      });
      this.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
    }
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    this.observer?.disconnect();
    this.element.remove();
  }
  private current(token: number) {
    return (
      !this.disposed && this.element.isConnected && token === this.generation
    );
  }
  private updateControls() {
    const busy = this.loading || this.exporting;
    this.refreshButton.disabled = busy;
    this.exportButton.disabled = busy;
    this.moreButton.disabled = busy;
    this.moreButton.hidden =
      !this.frozen || this.end.sequence >= this.frozen.sequence;
    if (
      this.moreButton.hidden &&
      document.activeElement === this.moreButton &&
      !busy
    )
      this.refreshButton.focus({ preventScroll: true });
    this.exportButton.textContent = this.exporting
      ? "Exporting…"
      : "Export history";
    this.element.setAttribute("aria-busy", String(busy));
  }
  private showError(error: unknown) {
    this.status.textContent =
      error instanceof Error
        ? error.message
        : "History could not be loaded. Try Refresh.";
    this.status.setAttribute("role", "alert");
  }
  private addEvent(e: AuditEvent) {
    const item = node("li"),
      row = node("div", undefined, "work-audit-event-heading"),
      date = new Date(e.at),
      time = node(
        "time",
        Number.isNaN(date.getTime())
          ? "Time unavailable"
          : date.toLocaleString(),
      );
    if (!Number.isNaN(date.getTime())) time.dateTime = date.toISOString();
    row.append(node("strong", label(e.kind)), time);
    item.append(row);
    const refs = [
      e.metadata.status ? label(e.metadata.status) : "",
      `${label(e.actor.kind)} · ${e.actor.id}`,
      e.taskId ? `Task ${e.taskId}` : "",
      e.attemptId ? `Attempt ${e.attemptId}` : "",
    ].filter(Boolean);
    item.append(node("p", refs.join(" · "), "work-audit-event-context"));
    const details = node("details", undefined, "work-audit-event-details");
    details.append(
      node("summary", "Integrity details"),
      node("p", `Event ${e.sequence} · Revision ${e.revision}`),
    );
    for (const [name, value] of [
      ["Event", e.hash],
      ["Previous", e.previousHash],
      ["Before", e.beforeHash ?? "No earlier recorded snapshot"],
      ["After", e.afterHash],
    ]) {
      const p = node("p");
      p.append(node("span", name + ": "), node("code", value));
      details.append(p);
    }
    item.append(details);
    this.list.append(item);
  }
  private async load(refresh: boolean) {
    if (
      this.disposed ||
      this.loading ||
      this.exporting ||
      !this.element.isConnected
    )
      return;
    const token = ++this.generation,
      captured = { ...this.scope };
    this.loading = true;
    this.status.setAttribute("role", "status");
    this.status.textContent = "Loading history…";
    this.updateControls();
    try {
      const frozen =
        refresh || !this.frozen
          ? head(
              await this.rpc("work.audit.head", {
                id: captured.goalId,
                profile: captured.profile,
              }),
              captured,
            )
          : this.frozen;
      if (!this.current(token)) return;
      const predecessor = refresh ? { sequence: 0, hash: zero } : this.end;
      const response = await this.rpc("work.audit.read", {
        id: captured.goalId,
        profile: captured.profile,
        afterSequence: predecessor.sequence,
        limit: 100,
        expectedHead: frozen,
      });
      if (!this.current(token)) return;
      const result = page(response, captured, frozen, predecessor);
      if (refresh) {
        this.list.replaceChildren();
        this.count = 0;
      }
      this.frozen = frozen;
      this.end = result.end;
      this.loaded = true;
      for (const e of result.events) this.addEvent(e);
      this.count += result.events.length;
      this.status.textContent =
        frozen.sequence === 0
          ? "History will start with the next recorded change. Earlier activity has not been reconstructed."
          : `${this.count.toLocaleString()} of ${frozen.sequence.toLocaleString()} recorded changes. Refresh to include newer activity.`;
      this.integrity.textContent = `Export snapshot: ${frozen.sequence} recorded changes. Head: ${frozen.hash}`;
    } catch (error) {
      if (this.current(token)) this.showError(error);
    } finally {
      if (this.current(token)) {
        this.loading = false;
        this.updateControls();
      }
    }
  }
  private async export() {
    if (
      this.disposed ||
      this.loading ||
      this.exporting ||
      !this.element.isConnected
    )
      return;
    const token = ++this.generation,
      captured = { ...this.scope };
    this.exporting = true;
    this.status.setAttribute("role", "status");
    this.status.textContent = "Preparing history export…";
    this.updateControls();
    try {
      const value = await this.rpc("work.audit.export", {
        id: captured.goalId,
        profile: captured.profile,
      });
      if (!this.current(token)) return;
      const bundle = record(value);
      checkScope(bundle.scope, captured);
      const frozen = point(bundle.head);
      const bundleHead = record(bundle.head);
      if (bundleHead.scope !== undefined)
        checkScope(bundleHead.scope, captured);
      if (
        bundle.schema !== "hades.work-audit-bundle.v1" ||
        !Array.isArray(bundle.pages) ||
        bundle.pages.length < 1 ||
        bundle.pages.length > 10
      )
        throw new Error("History export is incomplete.");
      let cursor = { sequence: 0, hash: zero };
      for (const [index, raw] of bundle.pages.entries()) {
        const p = page(raw, captured, frozen, cursor, 500);
        if (
          (!p.events.length &&
            (frozen.sequence !== 0 || bundle.pages.length !== 1)) ||
          p.hasMore !== index < bundle.pages.length - 1
        )
          throw new Error("History export is incomplete.");
        cursor = p.end;
      }
      if (!same(cursor, frozen))
        throw new Error("History export is incomplete.");
      const json = JSON.stringify(value, null, 2);
      if (new TextEncoder().encode(json).byteLength > 7 * 1024 * 1024)
        throw new Error(
          "History is too large for one export. Inspect it in pages.",
        );
      if (!this.current(token)) return;
      this.download(`work-history-${captured.goalId}.json`, json);
      this.status.textContent =
        "History export prepared. Check your downloads.";
    } catch (error) {
      if (this.current(token)) this.showError(error);
    } finally {
      if (this.current(token)) {
        this.exporting = false;
        this.updateControls();
      }
    }
  }
}
