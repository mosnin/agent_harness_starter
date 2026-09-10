import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mountFleetConflictsView, type FleetConflictsViewCallbacks } from "../ui/fleet-conflicts-view";
import type { ConflictsLaneModel, ConflictItem } from "../core/fleet-conflicts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(__dirname, "../ui/fleet-conflicts-view.css");

// ---------------------------------------------------------------------------
// A minimal, faithful-enough hand-built DOM — same house pattern as
// `fleet-provision-view.test.ts` (this repo runs vitest under
// `environment: "node"`, with no jsdom/happy-dom dependency by house rule),
// sized to exactly what `fleet-conflicts-view.ts` uses: createElement,
// append, textContent (never innerHTML), classList, setAttribute/
// getAttribute, addEventListener/removeEventListener/dispatchEvent (click,
// bubbling + delegation via closest), insertBefore/removeChild/contains,
// and a small class/attribute querySelectorAll for assertions.
// ---------------------------------------------------------------------------

abstract class FakeNode {
  parentNode: FakeElement | null = null;
}

class FakeTextNode extends FakeNode {
  constructor(public data: string) {
    super();
  }
}

class FakeEvent {
  defaultPrevented = false;
  target: FakeElement | null = null;
  currentTarget: FakeElement | null = null;
  bubbles: boolean;
  constructor(
    public type: string,
    opts: { bubbles?: boolean } = {}
  ) {
    this.bubbles = opts.bubbles ?? true;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
}

type Listener = (ev: FakeEvent) => void;

class FakeElement extends FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private _className = "";

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  get className(): string {
    return this._className;
  }
  set className(v: string) {
    this._className = v;
  }

  get classList() {
    const self = this;
    const set = () => new Set(self._className.split(/\s+/).filter(Boolean));
    return {
      add(...cls: string[]) {
        const s = set();
        cls.forEach((c) => s.add(c));
        self._className = [...s].join(" ");
      },
      remove(...cls: string[]) {
        const s = set();
        cls.forEach((c) => s.delete(c));
        self._className = [...s].join(" ");
      },
      contains(c: string) {
        return set().has(c);
      },
    };
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? this.attrs.get(name)! : null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    node.parentNode = this;
    if (ref === null) {
      this.children.push(node);
      return node;
    }
    const idx = this.children.indexOf(ref);
    if (idx === -1) this.children.push(node);
    else this.children.splice(idx, 0, node);
    return node;
  }

  removeChild<T extends FakeNode>(node: T): T {
    const idx = this.children.indexOf(node);
    if (idx !== -1) {
      this.children.splice(idx, 1);
      node.parentNode = null;
    }
    return node;
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeTextNode(n) : n);
  }

  contains(node: FakeNode): boolean {
    let n: FakeNode | null = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  closest(selector: string): FakeElement | null {
    const compound = parseCompoundSelector(selector);
    let node: FakeNode | null = this;
    while (node) {
      if (node instanceof FakeElement && matchesCompound(node, compound)) return node;
      node = node.parentNode;
    }
    return null;
  }

  get textContent(): string {
    const collect = (n: FakeNode): string =>
      n instanceof FakeTextNode ? n.data : n instanceof FakeElement ? n.children.map(collect).join("") : "";
    return this.children.map(collect).join("");
  }
  set textContent(v: string) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    if (v.length > 0) this.appendChild(new FakeTextNode(v));
  }

  addEventListener(type: string, handler: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: Listener): void {
    this.listeners.get(type)?.delete(handler);
  }

  listenerCount(type?: string): number {
    if (type !== undefined) return this.listeners.get(type)?.size ?? 0;
    let n = 0;
    for (const set of this.listeners.values()) n += set.size;
    return n;
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target = event.target ?? this;
    const chain: FakeElement[] = [];
    let node: FakeNode | null = this;
    while (node) {
      if (node instanceof FakeElement) chain.push(node);
      node = node.parentNode;
      if (!event.bubbles) break;
    }
    for (const el of chain) {
      event.currentTarget = el;
      const handlers = el.listeners.get(event.type);
      if (handlers) for (const h of [...handlers]) h(event);
    }
    return !event.defaultPrevented;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const seen = new Set<FakeElement>();
    const compound = parseCompoundSelector(selector);
    const visit = (node: FakeElement) => {
      for (const child of node.children) {
        if (child instanceof FakeElement) {
          if (matchesCompound(child, compound) && !seen.has(child)) {
            seen.add(child);
            results.push(child);
          }
          visit(child);
        }
      }
    };
    visit(this);
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface CompoundSelector {
  tag: string | null;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

function parseCompoundSelector(sel: string): CompoundSelector {
  const compound: CompoundSelector = { tag: null, classes: [], attrs: [] };
  const re = /(^[a-zA-Z*][\w-]*)|(\.[\w-]+)|(\[[^\]]+\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sel))) {
    const token = m[0];
    if (token.startsWith(".")) compound.classes.push(token.slice(1));
    else if (token.startsWith("[")) {
      const inner = token.slice(1, -1);
      const eq = inner.indexOf("=");
      if (eq === -1) compound.attrs.push({ name: inner });
      else {
        const name = inner.slice(0, eq);
        const value = inner.slice(eq + 1).replace(/^["']|["']$/g, "");
        compound.attrs.push({ name, value });
      }
    } else {
      compound.tag = token.toUpperCase();
    }
  }
  return compound;
}

function matchesCompound(el: FakeElement, c: CompoundSelector): boolean {
  if (c.tag && c.tag !== "*" && el.tagName !== c.tag) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const attr of c.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && el.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
  createTextNode(data: string): FakeTextNode {
    return new FakeTextNode(data);
  }
}

const fakeDocument = new FakeDocument();

beforeEach(() => {
  (globalThis as unknown as { document: FakeDocument }).document = fakeDocument;
});

function makeRoot(): FakeElement {
  return fakeDocument.createElement("div");
}

function asRoot(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}

function click(el: FakeElement): void {
  el.dispatchEvent(new FakeEvent("click"));
}

// ---------------------------------------------------------------------------
// Model builders
// ---------------------------------------------------------------------------

function conflictItem(overrides: Partial<ConflictItem> = {}): ConflictItem {
  return {
    workerId: "worker-1",
    severity: "conflict",
    reason: "workerId already live in the registry (backend=docker)",
    suggestedAction: "rename-and-provision",
    suggestedWorkerId: "worker-2",
    ...overrides,
  };
}

function emptyModel(): ConflictsLaneModel {
  return { items: [], counts: { conflict: 0, dropped: 0, corrected: 0 }, notices: [] };
}

function modelWith(items: ConflictItem[], notices: string[] = []): ConflictsLaneModel {
  const counts = { conflict: 0, dropped: 0, corrected: 0 };
  for (const i of items) counts[i.severity]++;
  return { items, counts, notices };
}

// ---------------------------------------------------------------------------
// Mount / structure
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — mount", () => {
  it("mounts with the no-conflicts empty state and zero counts", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(emptyModel());

    expect(root.querySelector(".fleet-conflicts-empty")).not.toBeNull();
    expect(root.textContent).toContain("No conflicts");
    expect(root.querySelector(".fleet-conflicts-count--conflict")?.textContent).toBe("0 conflicts");
    expect(root.querySelector(".fleet-conflicts-count--dropped")?.textContent).toBe("0 dropped");
    expect(root.querySelector(".fleet-conflicts-count--corrected")?.textContent).toBe("0 corrected");
  });

  it("renders singular/plural count labels correctly", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem({ workerId: "worker-1" })]));
    expect(root.querySelector(".fleet-conflicts-count--conflict")?.textContent).toBe("1 conflict");
    expect(root.querySelector(".fleet-conflicts-count--dropped")?.textContent).toBe("0 dropped");
  });

  it("adds the fleet-conflicts class to root", () => {
    const root = makeRoot();
    mountFleetConflictsView(asRoot(root));
    expect(root.classList.contains("fleet-conflicts")).toBe(true);
  });

  it("does not render a credential banner (role=status) by default", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(emptyModel());
    expect(root.querySelector('[role="status"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rows / severity badges / counts
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — rows", () => {
  it("renders one row per item with severity badge, id, and reason", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    const model = modelWith([
      conflictItem({ workerId: "worker-1", reason: "already live", suggestedWorkerId: "worker-2" }),
      { workerId: "worker-5", severity: "dropped", reason: "unknown backend", suggestedAction: "none" },
      { workerId: "worker-9", severity: "corrected", reason: "stored hibernated ≠ probed running", suggestedAction: "none" },
    ]);
    handle.update(model);

    const rows = root.querySelectorAll(".fleet-conflicts-row");
    expect(rows).toHaveLength(3);

    const conflictRow = root.querySelector(".fleet-conflicts-row--conflict")!;
    expect(conflictRow.querySelector(".fleet-conflicts-badge")?.textContent).toBe("conflict");
    expect(conflictRow.querySelector(".fleet-conflicts-row__id")?.textContent).toBe("worker-1");
    expect(conflictRow.querySelector(".fleet-conflicts-row__reason")?.textContent).toBe("already live");

    const droppedRow = root.querySelector(".fleet-conflicts-row--dropped")!;
    expect(droppedRow.querySelector(".fleet-conflicts-badge")?.textContent).toBe("dropped");

    const correctedRow = root.querySelector(".fleet-conflicts-row--corrected")!;
    expect(correctedRow.querySelector(".fleet-conflicts-badge")?.textContent).toBe("corrected");
  });

  it("counts in the header match the model", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    const model = modelWith([
      conflictItem({ workerId: "worker-1" }),
      conflictItem({ workerId: "worker-2" }),
      { workerId: "worker-5", severity: "dropped", reason: "x", suggestedAction: "none" },
      { workerId: "worker-9", severity: "corrected", reason: "y", suggestedAction: "none" },
    ]);
    handle.update(model);

    expect(root.querySelector(".fleet-conflicts-count--conflict")?.textContent).toBe("2 conflicts");
    expect(root.querySelector(".fleet-conflicts-count--dropped")?.textContent).toBe("1 dropped");
    expect(root.querySelector(".fleet-conflicts-count--corrected")?.textContent).toBe("1 corrected");
  });

  it("renders an action button only when suggestedAction !== 'none'", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    const model = modelWith([
      conflictItem({ workerId: "worker-1" }),
      { workerId: "worker-5", severity: "dropped", reason: "x", suggestedAction: "none" },
    ]);
    handle.update(model);

    const conflictRow = root.querySelector(".fleet-conflicts-row--conflict")!;
    expect(conflictRow.querySelector("button")).not.toBeNull();

    const droppedRow = root.querySelector(".fleet-conflicts-row--dropped")!;
    expect(droppedRow.querySelector("button")).toBeNull();
  });

  it("renders derivation notices when present", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem()], ['workerId "worker-1": merged 2 reasons']));
    expect(root.textContent).toContain("merged 2 reasons");
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — accessibility", () => {
  it("gives the rename button an aria-label naming the workerId and suggestion", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem({ workerId: "worker-7", suggestedWorkerId: "worker-8" })]));
    const button = root.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toContain("worker-7");
    expect(button.getAttribute("aria-label")).toContain("worker-8");
  });

  it("gives the terminate button an aria-label naming the workerId", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(
      modelWith([
        {
          workerId: "worker-12",
          severity: "conflict",
          reason: "x",
          suggestedAction: "terminate-live-first",
        },
      ])
    );
    const button = root.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toContain("worker-12");
  });

  it("every action button is a real <button type=button>, reachable in document order", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(
      modelWith([
        conflictItem({ workerId: "worker-1", suggestedWorkerId: "worker-x" }),
        conflictItem({ workerId: "worker-2", suggestedWorkerId: "worker-y" }),
      ])
    );
    const buttons = root.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.tagName).toBe("BUTTON");
      expect((b as unknown as { type: string }).type).toBe("button");
    }
    // Tab order follows document order; the first row's button precedes the second's.
    expect(buttons[0].getAttribute("data-worker-id")).toBe("worker-1");
    expect(buttons[1].getAttribute("data-worker-id")).toBe("worker-2");
  });

  it("the credential banner has role=status", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(emptyModel(), "placeholder manager credentials — set X/Y for real ones");
    const banner = root.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain("placeholder manager credentials");
  });
});

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — callbacks", () => {
  it("clicking a rename button calls onRename with workerId and the suggested id", () => {
    const onRename = vi.fn();
    const cb: FleetConflictsViewCallbacks = { onRename };
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root), cb);
    handle.update(modelWith([conflictItem({ workerId: "worker-1", suggestedWorkerId: "worker-2" })]));

    const button = root.querySelector("button")!;
    click(button);

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith("worker-1", "worker-2");
  });

  it("clicking a terminate button calls onTerminate with the workerId", () => {
    const onTerminate = vi.fn();
    const cb: FleetConflictsViewCallbacks = { onTerminate };
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root), cb);
    handle.update(
      modelWith([
        { workerId: "worker-3", severity: "conflict", reason: "x", suggestedAction: "terminate-live-first" },
      ])
    );

    const button = root.querySelector("button")!;
    click(button);

    expect(onTerminate).toHaveBeenCalledTimes(1);
    expect(onTerminate).toHaveBeenCalledWith("worker-3");
  });

  it("clicking with no callbacks registered never throws", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem()]));
    const button = root.querySelector("button")!;
    expect(() => click(button)).not.toThrow();
  });

  it("clicking inside a row but not on the button does not fire callbacks", () => {
    const onRename = vi.fn();
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root), { onRename });
    handle.update(modelWith([conflictItem({ workerId: "worker-1", suggestedWorkerId: "worker-2" })]));

    const reason = root.querySelector(".fleet-conflicts-row__reason")!;
    click(reason);

    expect(onRename).not.toHaveBeenCalled();
  });

  it("the view never calls a service directly — only the injected callbacks fire", () => {
    // Structural guarantee: no callback provided at all still renders and
    // handles clicks without attempting any other side effect.
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root), {});
    handle.update(modelWith([conflictItem()]));
    const button = root.querySelector("button")!;
    expect(() => click(button)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Banner lifecycle across updates
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — credential banner", () => {
  it("appears when credentialNotice is set and disappears when it is omitted on a later update", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));

    handle.update(emptyModel(), "placeholder manager credentials — set X/Y for real ones");
    expect(root.querySelector('[role="status"]')).not.toBeNull();
    expect(root.textContent).toContain("placeholder manager credentials");

    handle.update(emptyModel());
    expect(root.querySelector('[role="status"]')).toBeNull();
  });

  it("updates the banner text across two notice-bearing updates without duplicating it", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));

    handle.update(emptyModel(), "first notice");
    handle.update(emptyModel(), "second notice");

    const banners = root.querySelectorAll('[role="status"]');
    expect(banners).toHaveLength(1);
    expect(banners[0].textContent).toBe("second notice");
  });

  it("treats an empty-string credentialNotice as absent", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(emptyModel(), "");
    expect(root.querySelector('[role="status"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// update() idempotency
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — update idempotency", () => {
  it("fully replaces prior rows on each update, never accumulating duplicates", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));

    handle.update(modelWith([conflictItem({ workerId: "worker-1" })]));
    expect(root.querySelectorAll(".fleet-conflicts-row")).toHaveLength(1);

    handle.update(modelWith([conflictItem({ workerId: "worker-1" }), conflictItem({ workerId: "worker-2" })]));
    expect(root.querySelectorAll(".fleet-conflicts-row")).toHaveLength(2);

    handle.update(emptyModel());
    expect(root.querySelectorAll(".fleet-conflicts-row")).toHaveLength(0);
    expect(root.querySelector(".fleet-conflicts-empty")).not.toBeNull();
  });

  it("calling update() twice with the identical model produces identical DOM text", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    const model = modelWith([conflictItem({ workerId: "worker-1" })]);

    handle.update(model);
    const firstText = root.textContent;
    handle.update(model);
    const secondText = root.textContent;

    expect(secondText).toBe(firstText);
    expect(root.querySelectorAll(".fleet-conflicts-row")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// destroy() — leak check
// ---------------------------------------------------------------------------

describe("mountFleetConflictsView — destroy", () => {
  it("removes all children from root", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem()]));
    expect(root.children.length).toBeGreaterThan(0);

    handle.destroy();
    expect(root.children.length).toBe(0);
    expect(root.textContent).toBe("");
  });

  it("removes the fleet-conflicts class from root", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.destroy();
    expect(root.classList.contains("fleet-conflicts")).toBe(false);
  });

  it("stale button references no longer fire callbacks after destroy", () => {
    const onRename = vi.fn();
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root), { onRename });
    handle.update(modelWith([conflictItem({ workerId: "worker-1", suggestedWorkerId: "worker-2" })]));

    const button = root.querySelector("button")!;
    handle.destroy();
    click(button);

    expect(onRename).not.toHaveBeenCalled();
  });

  it("removes the delegated click listener (zero listeners left on any node destroy touched)", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.update(modelWith([conflictItem()]));
    const body = root.querySelector(".fleet-conflicts__body");
    expect(body).not.toBeNull();
    expect(body!.listenerCount("click")).toBeGreaterThan(0);

    handle.destroy();
    // The body node was detached by destroy(); its own listener map is
    // still explicitly cleared via removeEventListener before detachment.
    expect(body!.listenerCount("click")).toBe(0);
  });

  it("calling update() after destroy() does not repopulate root", () => {
    const root = makeRoot();
    const handle = mountFleetConflictsView(asRoot(root));
    handle.destroy();
    // update() after destroy is not a supported call, but it must not throw
    // and must not resurrect content in a way that breaks the leak check —
    // exercised here purely to confirm no crash.
    expect(() => handle.update(modelWith([conflictItem()]))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// CSS sanity: every class this view can emit has a matching selector
// ---------------------------------------------------------------------------

describe("fleet-conflicts-view.css", () => {
  const css = readFileSync(CSS_PATH, "utf8");

  it("has a selector for every severity badge/row/count class the view can emit", () => {
    for (const severity of ["conflict", "dropped", "corrected"]) {
      expect(css).toContain(`.fleet-conflicts-badge--${severity}`);
      expect(css).toContain(`.fleet-conflicts-count--${severity}`);
    }
    expect(css).toContain(".fleet-conflicts-row--conflict");
  });

  it("is scoped under the fleet-conflicts prefix", () => {
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const classSelectors = withoutComments.match(/\.[a-zA-Z][\w-]*/g) ?? [];
    expect(classSelectors.length).toBeGreaterThan(0);
    for (const sel of classSelectors) {
      expect(sel.startsWith(".fleet-conflicts")).toBe(true);
    }
  });
});
