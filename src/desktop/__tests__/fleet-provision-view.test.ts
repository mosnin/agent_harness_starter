import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createFleetProvisionView, type FleetProvisionWire } from "../ui/fleet-provision-view";
import type { FleetProvisionCommand, FleetProvisionEvent } from "../ipc/fleet-provision-contract";
import type { FleetWorkerView } from "../ipc/fleet-contract";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = join(__dirname, "../ui/fleet-provision-view.css");

// ---------------------------------------------------------------------------
// A minimal, faithful-enough DOM: this repo has no jsdom/happy-dom
// dependency (framework-free by house rule), so this view — the first in
// `src/desktop/ui/` that needs to own real DOM nodes and real event
// listeners rather than emit an HTML string — is exercised here against a
// small hand-built DOM implementing exactly the surface it uses:
// createElement, append/insertBefore/removeChild, classList, dataset,
// textContent (never innerHTML — nothing here ever parses a string as
// markup, which is itself part of what makes the XSS-resistance assertions
// below meaningful rather than vacuous), addEventListener/removeEventListener,
// querySelector(All), focus(), and the two native browser default actions
// the view's keyboard flow depends on: Enter in a text input inside a
// <form> submits it, and clicking a type="submit" button does too — both
// only when the event's default wasn't already prevented, exactly like a
// real browser.
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
  private _stopped = false;
  constructor(
    public type: string,
    opts: { bubbles?: boolean } = {}
  ) {
    this.bubbles = opts.bubbles ?? true;
  }
  preventDefault(): void {
    this.defaultPrevented = true;
  }
  stopPropagation(): void {
    this._stopped = true;
  }
  get stopped(): boolean {
    return this._stopped;
  }
}

class FakeKeyboardEvent extends FakeEvent {
  key: string;
  constructor(type: string, opts: { key: string; bubbles?: boolean }) {
    super(type, opts);
    this.key = opts.key;
  }
}

type Listener = (ev: FakeEvent) => void;

const NON_SUBMITTING_INPUT_TYPES = new Set(["checkbox", "radio", "button", "submit", "reset"]);

class FakeElement extends FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private _className = "";

  // Generic form-control-ish properties — every FakeElement carries them
  // (unused ones just sit idle), which is fine for a test-only shim.
  id = "";
  value = "";
  checked = false;
  type = "";
  placeholder = "";
  min = "";
  step = "";
  hidden = false;
  noValidate = false;
  htmlFor = "";

  constructor(tag: string) {
    super();
    this.tagName = tag.toUpperCase();
  }

  // -- class / dataset ----------------------------------------------------

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

  get dataset(): Record<string, string | undefined> {
    const self = this;
    return new Proxy(
      {},
      {
        get(_t, prop: string) {
          return self.attrs.get(`data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
        },
        set(_t, prop: string, value) {
          self.attrs.set(`data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(value));
          return true;
        },
      }
    ) as Record<string, string | undefined>;
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

  // -- tree -----------------------------------------------------------------

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

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeTextNode(n) : n);
  }

  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }

  contains(node: FakeNode): boolean {
    let n: FakeNode | null = node;
    while (n) {
      if (n === this) return true;
      n = n.parentNode;
    }
    return false;
  }

  closest(tag: string): FakeElement | null {
    let node: FakeNode | null = this;
    while (node) {
      if (node instanceof FakeElement && node.tagName === tag) return node;
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

  // -- events -----------------------------------------------------------------

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
      if (event.stopped) break;
    }

    // Native default actions — only the two this view's keyboard flow
    // actually relies on, both gated on "default wasn't prevented", exactly
    // like a real browser.
    if (!event.defaultPrevented) {
      if (
        event.type === "keydown" &&
        (event as FakeKeyboardEvent).key === "Enter" &&
        this.tagName === "INPUT" &&
        !NON_SUBMITTING_INPUT_TYPES.has(this.type)
      ) {
        this.closest("FORM")?.dispatchEvent(new FakeEvent("submit"));
      }
      if (event.type === "click" && this.tagName === "BUTTON" && (this.type === "submit" || this.type === "")) {
        this.closest("FORM")?.dispatchEvent(new FakeEvent("submit"));
      }
    }

    return !event.defaultPrevented;
  }

  focus(): void {
    fakeDocument.activeElement = this;
  }
  blur(): void {
    if (fakeDocument.activeElement === this) fakeDocument.activeElement = null;
  }

  // -- selectors --------------------------------------------------------------

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = [];
    const seen = new Set<FakeElement>();
    for (const branch of selector.split(",").map((s) => s.trim())) {
      const levels = branch.split(/\s+/).filter(Boolean).map(parseCompoundSelector);
      collectMatches(this, levels, results, seen);
    }
    return results;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

interface CompoundSelector {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; value?: string }>;
}

function parseCompoundSelector(sel: string): CompoundSelector {
  const compound: CompoundSelector = { tag: null, id: null, classes: [], attrs: [] };
  const re = /(^[a-zA-Z*][\w-]*)|(#[\w-]+)|(\.[\w-]+)|(\[[^\]]+\])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sel))) {
    const token = m[0];
    if (token.startsWith("#")) compound.id = token.slice(1);
    else if (token.startsWith(".")) compound.classes.push(token.slice(1));
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
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const attr of c.attrs) {
    if (!el.hasAttribute(attr.name)) return false;
    if (attr.value !== undefined && el.getAttribute(attr.name) !== attr.value) return false;
  }
  return true;
}

function ancestorChainMatches(el: FakeElement, levels: CompoundSelector[]): boolean {
  let li = levels.length - 2;
  let node: FakeNode | null = el.parentNode;
  while (li >= 0 && node) {
    if (node instanceof FakeElement && matchesCompound(node, levels[li])) li--;
    node = node.parentNode;
  }
  return li < 0;
}

function collectMatches(root: FakeElement, levels: CompoundSelector[], out: FakeElement[], seen: Set<FakeElement>): void {
  const last = levels[levels.length - 1];
  const visit = (node: FakeElement) => {
    for (const child of node.children) {
      if (child instanceof FakeElement) {
        if (matchesCompound(child, last) && (levels.length === 1 || ancestorChainMatches(child, levels))) {
          if (!seen.has(child)) {
            seen.add(child);
            out.push(child);
          }
        }
        visit(child);
      }
    }
  };
  visit(root);
}

class FakeDocument {
  activeElement: FakeElement | null = null;
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
  fakeDocument.activeElement = null;
});

function makeHost(): FakeElement {
  return fakeDocument.createElement("div");
}

function asHost(el: FakeElement): HTMLElement {
  return el as unknown as HTMLElement;
}

function pressKey(el: FakeElement, key: string): FakeKeyboardEvent {
  const ev = new FakeKeyboardEvent("keydown", { key });
  el.dispatchEvent(ev);
  return ev;
}

function click(el: FakeElement): void {
  el.dispatchEvent(new FakeEvent("click"));
}

// ---------------------------------------------------------------------------
// Mock wire
// ---------------------------------------------------------------------------

function createMockWire() {
  const subscribers = new Set<(e: FleetProvisionEvent) => void>();
  const sent: FleetProvisionCommand[] = [];
  const wire: FleetProvisionWire = {
    send: vi.fn((cmd: FleetProvisionCommand) => {
      sent.push(cmd);
    }),
    onEvent: vi.fn((cb: (e: FleetProvisionEvent) => void) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    }),
  };
  return {
    wire,
    sent,
    subscribers,
    emit(event: FleetProvisionEvent) {
      for (const cb of [...subscribers]) cb(event);
    },
  };
}

function worker(overrides: Partial<FleetWorkerView> = {}): FleetWorkerView {
  return {
    workerId: "w-1",
    backend: "docker",
    nativeId: "docker-1",
    state: "running",
    startedAt: 1_700_000_000_000,
    idleMs: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mount smoke test + structure
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — mount", () => {
  it("builds the form, pending lane, and restored lane, and applies the wrapper class", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    expect(host.classList.contains("fleet-provision-view")).toBe(true);
    expect(host.querySelector("form.fleet-provision-form")).not.toBeNull();
    expect(host.querySelector(".fleet-provision-pending")).not.toBeNull();
    expect(host.querySelector(".fleet-provision-restored")).not.toBeNull();
    expect(host.querySelector(".fleet-provision-empty")?.textContent).toBe("No restore has run yet.");

    view.destroy();
  });

  it("auto-suggests a non-empty worker id", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id");
    expect(workerIdInput).not.toBeNull();
    expect(workerIdInput!.value.length).toBeGreaterThan(0);

    view.destroy();
  });

  it("focuses the worker id field on mount", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    expect(fakeDocument.activeElement).toBe(host.querySelector("#fleet-provision-worker-id"));

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Focus order — every control reachable by Tab, in natural DOM order
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — focus order", () => {
  it("lists every interactive control in the form in a sensible, stable document order", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const controls = host.querySelectorAll("input, button");
    const ids = controls.map((c) => c.id || `${c.tagName}:${c.textContent}`);

    expect(ids).toEqual([
      "fleet-provision-worker-id",
      "fleet-provision-image",
      "fleet-provision-capability-input",
      "fleet-provision-exclude-input",
      "fleet-provision-require-hibernate",
      "fleet-provision-max-cost",
      "BUTTON:Provision",
    ]);

    // None of them are pulled out of tab order.
    for (const c of controls) {
      expect(c.getAttribute("tabindex")).not.toBe("-1");
    }

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Keyboard flow: Enter submits, chip Enter does not, Escape clears
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — keyboard flow", () => {
  it("Enter in the worker id field submits the form and sends a well-formed fleet.provision command", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    workerIdInput.value = "gpu-worker";
    pressKey(workerIdInput, "Enter");

    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("fleet.provision");
    expect(sent[0].spec.workerId).toBe("gpu-worker");
    expect(sent[0].requestId.length).toBeGreaterThan(0);
    expect(sent[0].spec.capabilities).toEqual([]);

    view.destroy();
  });

  it("Enter in the capabilities chip input adds a chip and does NOT submit the form", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const capInput = host.querySelector("#fleet-provision-capability-input")!;
    capInput.value = "gpu";
    pressKey(capInput, "Enter");

    expect(sent).toHaveLength(0);
    expect(capInput.value).toBe("");
    const chips = host.querySelectorAll(".fleet-provision-chip .fleet-provision-chip__text");
    expect(chips.map((c) => c.textContent)).toEqual(["gpu"]);

    view.destroy();
  });

  it("submitting includes every committed capability chip, and auto-commits whatever is still typed but not yet committed", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const capInput = host.querySelector("#fleet-provision-capability-input")!;
    capInput.value = "gpu";
    pressKey(capInput, "Enter");
    capInput.value = "linux"; // typed but never committed with Enter

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    workerIdInput.value = "w-multi";
    pressKey(workerIdInput, "Enter");

    expect(sent).toHaveLength(1);
    expect(sent[0].spec.capabilities.sort()).toEqual(["gpu", "linux"].sort());

    view.destroy();
  });

  it("clicking the Provision button also submits (native submit-button behavior)", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const submitButton = host.querySelectorAll("button").find((b) => b.textContent === "Provision")!;
    click(submitButton);

    expect(sent).toHaveLength(1);

    view.destroy();
  });

  it("Escape resets the worker id, capabilities, exclude list, toggle, and cost field, and re-focuses worker id", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    const originalSuggestion = workerIdInput.value;
    workerIdInput.value = "something-typed";

    const capInput = host.querySelector("#fleet-provision-capability-input")!;
    capInput.value = "gpu";
    pressKey(capInput, "Enter");
    expect(host.querySelectorAll(".fleet-provision-chip")).toHaveLength(1);

    const requireHibernate = host.querySelector("#fleet-provision-require-hibernate")!;
    requireHibernate.checked = true;

    const maxCost = host.querySelector("#fleet-provision-max-cost")!;
    maxCost.value = "1.5";

    pressKey(workerIdInput, "Escape");

    expect(workerIdInput.value).not.toBe("something-typed");
    expect(workerIdInput.value).not.toBe(originalSuggestion); // suggestion advances on reset
    expect(host.querySelectorAll(".fleet-provision-chip")).toHaveLength(0);
    expect(requireHibernate.checked).toBe(false);
    expect(maxCost.value).toBe("");
    expect(fakeDocument.activeElement).toBe(workerIdInput);

    view.destroy();
  });

  it("Escape does not clear an already-populated pending lane", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    workerIdInput.value = "w-keep";
    pressKey(workerIdInput, "Enter");
    expect(host.querySelectorAll(".fleet-provision-pending__row")).toHaveLength(1);

    pressKey(workerIdInput, "Escape");
    expect(host.querySelectorAll(".fleet-provision-pending__row")).toHaveLength(1);

    view.destroy();
  });

  it("rejects an empty worker id with an inline validation message and never calls wire.send", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    workerIdInput.value = "   ";
    pressKey(workerIdInput, "Enter");

    expect(sent).toHaveLength(0);
    const validation = host.querySelector(".fleet-provision-validation")!;
    expect(validation.hidden).toBe(false);
    expect(validation.textContent.length).toBeGreaterThan(0);

    view.destroy();
  });

  it("rejects a negative max-cost with an inline validation message and never calls wire.send", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-ok";
    const maxCost = host.querySelector("#fleet-provision-max-cost")!;
    maxCost.value = "-5";
    pressKey(maxCost, "Enter");

    expect(sent).toHaveLength(0);
    expect(host.querySelector(".fleet-provision-validation")!.hidden).toBe(false);

    view.destroy();
  });

  it("builds requirements only from populated fields, and omits requirements entirely when nothing was set", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-bare";
    pressKey(host.querySelector("#fleet-provision-worker-id")!, "Enter");
    expect(sent[0].requirements).toBeUndefined();

    view.destroy();
  });

  it("populates requirements (requireHibernate, maxRunningHourUsd, exclude) when the operator sets them", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-req";
    host.querySelector("#fleet-provision-require-hibernate")!.checked = true;
    host.querySelector("#fleet-provision-max-cost")!.value = "0.75";
    const excludeInput = host.querySelector("#fleet-provision-exclude-input")!;
    excludeInput.value = "flaky-backend";
    pressKey(excludeInput, "Enter");

    pressKey(host.querySelector("#fleet-provision-worker-id")!, "Enter");

    expect(sent).toHaveLength(1);
    expect(sent[0].requirements).toEqual({
      requireHibernate: true,
      maxRunningHourUsd: 0.75,
      exclude: ["flaky-backend"],
    });

    view.destroy();
  });

  it("a chip's remove button removes exactly that chip", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const capInput = host.querySelector("#fleet-provision-capability-input")!;
    for (const cap of ["gpu", "linux", "docker"]) {
      capInput.value = cap;
      pressKey(capInput, "Enter");
    }
    expect(host.querySelectorAll(".fleet-provision-chip")).toHaveLength(3);

    const removeButtons = host.querySelectorAll(".fleet-provision-chip__remove");
    click(removeButtons[1]); // remove "linux"

    const remaining = host
      .querySelectorAll(".fleet-provision-chip__text")
      .map((c) => c.textContent);
    expect(remaining).toEqual(["gpu", "docker"]);

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Pending lane: pending -> success / pending -> error, keyed by requestId
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — pending lane transitions", () => {
  it("pending -> success: the row for that requestId updates in place with the worker's fields", () => {
    const host = makeHost();
    const { wire, sent, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-success";
    pressKey(host.querySelector("#fleet-provision-worker-id")!, "Enter");
    const requestId = sent[0].requestId;

    let row = host.querySelector(`[data-request-id="${requestId}"]`)!;
    expect(row.className).toContain("fleet-provision-pending__row--pending");

    emit({
      kind: "fleet.provisioned",
      requestId,
      worker: worker({ workerId: "w-success", backend: "docker", state: "running" }),
      backend: "docker",
      at: 1,
    });

    row = host.querySelector(`[data-request-id="${requestId}"]`)!;
    expect(row.className).toContain("fleet-provision-pending__row--success");
    expect(row.className).not.toContain("--pending");
    expect(row.textContent).toContain("w-success");
    expect(row.textContent).toContain("docker");
    expect(row.textContent).toContain("running");

    view.destroy();
  });

  it("pending -> error: the row for that requestId updates in place with the error message", () => {
    const host = makeHost();
    const { wire, sent, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-fail";
    pressKey(host.querySelector("#fleet-provision-worker-id")!, "Enter");
    const requestId = sent[0].requestId;

    emit({ kind: "fleet.provision.error", requestId, message: "no eligible backend", at: 1 });

    const row = host.querySelector(`[data-request-id="${requestId}"]`)!;
    expect(row.className).toContain("fleet-provision-pending__row--error");
    expect(row.textContent).toContain("no eligible backend");

    view.destroy();
  });

  it("two concurrent submissions resolve independently, each to its own row", () => {
    const host = makeHost();
    const { wire, sent, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const workerIdInput = host.querySelector("#fleet-provision-worker-id")!;
    workerIdInput.value = "w-a";
    pressKey(workerIdInput, "Enter");
    const idA = sent[0].requestId;

    workerIdInput.value = "w-b";
    pressKey(workerIdInput, "Enter");
    const idB = sent[1].requestId;

    expect(host.querySelectorAll(".fleet-provision-pending__row")).toHaveLength(2);

    emit({ kind: "fleet.provisioned", requestId: idB, worker: worker({ workerId: "w-b" }), backend: "docker", at: 1 });
    emit({ kind: "fleet.provision.error", requestId: idA, message: "boom", at: 2 });

    const rowA = host.querySelector(`[data-request-id="${idA}"]`)!;
    const rowB = host.querySelector(`[data-request-id="${idB}"]`)!;
    expect(rowA.className).toContain("--error");
    expect(rowB.className).toContain("--success");
    expect(rowA.textContent).toContain("boom");
    expect(rowB.textContent).toContain("w-b");

    view.destroy();
  });

  it("an event for a requestId this view never submitted still renders (defensive, never silently dropped)", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({
      kind: "fleet.provisioned",
      requestId: "foreign-request",
      worker: worker({ workerId: "w-foreign" }),
      backend: "docker",
      at: 1,
    });

    const row = host.querySelector('[data-request-id="foreign-request"]')!;
    expect(row).not.toBeNull();
    expect(row.textContent).toContain("w-foreign");

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// Restored lane
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — restored lane", () => {
  it("shows the 'no restore yet' placeholder before any fleet.restored event arrives", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    expect(host.querySelector(".fleet-provision-restored")!.textContent).toBe("No restore has run yet.");

    view.destroy();
  });

  it("distinguishes 'ran with nothing to recover' from 'no restore ran yet'", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({ kind: "fleet.restored", workers: [], adoptedIds: [], dropped: [], at: 1 });
    expect(host.querySelector(".fleet-provision-restored")!.textContent).toBe(
      "Restore ran with nothing to recover."
    );

    view.destroy();
  });

  it("renders adopted workers with the adopted badge and workers not in adoptedIds without it", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({
      kind: "fleet.restored",
      workers: [worker({ workerId: "w-adopted" }), worker({ workerId: "w-not-adopted" })],
      adoptedIds: ["w-adopted"],
      dropped: [],
      at: 1,
    });

    const rows = host.querySelectorAll(".fleet-provision-restored__row");
    expect(rows).toHaveLength(2);

    const adoptedRow = rows.find((r) => r.dataset.workerId === "w-adopted")!;
    const notAdoptedRow = rows.find((r) => r.dataset.workerId === "w-not-adopted")!;
    expect(adoptedRow.querySelector(".fleet-provision-badge--adopted")).not.toBeNull();
    expect(notAdoptedRow.querySelector(".fleet-provision-badge--adopted")).toBeNull();

    view.destroy();
  });

  it("renders dropped entries with their reason, verbatim, distinct from the adopted list", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({
      kind: "fleet.restored",
      workers: [worker({ workerId: "w-1" })],
      adoptedIds: ["w-1"],
      dropped: [
        { workerId: "w-2", reason: "handle store entry unreadable" },
        { workerId: "w-3", reason: "backend no longer registered" },
      ],
      at: 1,
    });

    const droppedRows = host.querySelectorAll(".fleet-provision-restored__dropped-row");
    expect(droppedRows).toHaveLength(2);
    const byId = Object.fromEntries(droppedRows.map((r) => [r.dataset.workerId, r.textContent]));
    expect(byId["w-2"]).toContain("handle store entry unreadable");
    expect(byId["w-3"]).toContain("backend no longer registered");

    view.destroy();
  });

  it("a later fleet.restored event replaces the lane wholesale rather than accumulating", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({ kind: "fleet.restored", workers: [worker({ workerId: "w-first" })], adoptedIds: [], dropped: [], at: 1 });
    expect(host.querySelectorAll(".fleet-provision-restored__row")).toHaveLength(1);

    emit({
      kind: "fleet.restored",
      workers: [worker({ workerId: "w-second" }), worker({ workerId: "w-third" })],
      adoptedIds: [],
      dropped: [],
      at: 2,
    });
    const rows = host.querySelectorAll(".fleet-provision-restored__row");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dataset.workerId)).toEqual(["w-second", "w-third"]);

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// XSS resistance
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — XSS resistance", () => {
  const evil = '<script>alert(1)</script>';

  it("a hostile workerId in a fleet.provisioned event renders inert via textContent, never as a script element", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({ kind: "fleet.provisioned", requestId: "r-evil", worker: worker({ workerId: evil }), backend: "docker", at: 1 });

    const row = host.querySelector('[data-request-id="r-evil"]')!;
    expect(row.querySelectorAll("script")).toHaveLength(0);
    expect(row.textContent).toContain(evil);

    view.destroy();
  });

  it("a hostile error message renders inert via textContent, never as a script element", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({ kind: "fleet.provision.error", requestId: "r-evil-2", message: evil, at: 1 });

    const row = host.querySelector('[data-request-id="r-evil-2"]')!;
    expect(row.querySelectorAll("script")).toHaveLength(0);
    expect(row.textContent).toContain(evil);

    view.destroy();
  });

  it("a hostile restored worker id and dropped reason render inert via textContent", () => {
    const host = makeHost();
    const { wire, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    emit({
      kind: "fleet.restored",
      workers: [worker({ workerId: evil })],
      adoptedIds: [evil],
      dropped: [{ workerId: "w-dropped", reason: evil }],
      at: 1,
    });

    const lane = host.querySelector(".fleet-provision-restored")!;
    expect(lane.querySelectorAll("script")).toHaveLength(0);
    expect(lane.textContent).toContain(evil);

    view.destroy();
  });
});

// ---------------------------------------------------------------------------
// destroy(): unsubscribe + DOM teardown, no orphan listeners
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — destroy", () => {
  it("unsubscribes from wire.onEvent (subscriber count drops to zero) and empties the host", () => {
    const host = makeHost();
    const { wire, subscribers } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    expect(subscribers.size).toBe(1);
    view.destroy();

    expect(subscribers.size).toBe(0);
    expect(host.textContent).toBe("");
    expect(host.classList.contains("fleet-provision-view")).toBe(false);
  });

  it("events emitted after destroy() have no effect (the callback is truly gone, not just a no-op flag)", () => {
    const host = makeHost();
    const { wire, sent, emit } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    host.querySelector("#fleet-provision-worker-id")!.value = "w-pre-destroy";
    pressKey(host.querySelector("#fleet-provision-worker-id")!, "Enter");
    const requestId = sent[0].requestId;

    view.destroy();

    // Firing the exact event that would have resolved the pending row must not throw,
    // and — since destroy() already emptied host — must not repopulate it.
    expect(() =>
      emit({ kind: "fleet.provisioned", requestId, worker: worker(), backend: "docker", at: 1 })
    ).not.toThrow();
    expect(host.children).toHaveLength(0);
  });

  it("calling destroy() twice is safe (idempotent teardown)", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);
    view.destroy();
    expect(() => view.destroy()).not.toThrow();
  });

  it("destroy() removes the form's own listeners too (submit after destroy sends nothing further)", () => {
    const host = makeHost();
    const { wire, sent } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);

    const form = host.querySelector("form")!;
    expect(form.listenerCount("submit")).toBeGreaterThan(0);

    view.destroy();
    expect(form.listenerCount("submit")).toBe(0);
    expect(form.listenerCount("keydown")).toBe(0);
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Theme / CSS token coverage — mirrors the fleet-view.test.ts pattern
// ---------------------------------------------------------------------------

describe("createFleetProvisionView — theme application", () => {
  it("applies the fleet-provision-view wrapper class on mount (the CSS hook both themes key off of)", () => {
    const host = makeHost();
    const { wire } = createMockWire();
    const view = createFleetProvisionView(asHost(host), wire);
    expect(host.classList.contains("fleet-provision-view")).toBe(true);
    view.destroy();
  });

  it("fleet-provision-view.css routes every color through a tokens.css custom property — no hardcoded hex/rgb, so light and dark both fall out of the mounted token set", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    expect(css).toContain("{");
    expect(css).toContain("}");
    expect(css).toMatch(/var\(--color-/);
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).not.toMatch(/rgba?\(/);
  });

  it("every className the view can produce has a matching selector in fleet-provision-view.css", () => {
    const css = readFileSync(CSS_PATH, "utf8");
    const classNames = [
      "fleet-provision-view",
      "fleet-provision-form",
      "fleet-provision-field",
      "fleet-provision-chip",
      "fleet-provision-chip__remove",
      "fleet-provision-pending",
      "fleet-provision-pending__row--pending",
      "fleet-provision-pending__row--success",
      "fleet-provision-pending__row--error",
      "fleet-provision-restored",
      "fleet-provision-restored__row",
      "fleet-provision-restored__dropped-row",
      "fleet-provision-badge--adopted",
      "fleet-provision-spinner",
    ];
    for (const cls of classNames) {
      const re = new RegExp(`\\.${cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      expect(css, `expected a selector for .${cls}`).toMatch(re);
    }
  });
});
