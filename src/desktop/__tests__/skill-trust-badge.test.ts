/**
 * skill-trust-badge.test.ts
 *
 * A minimal, faithful-enough hand-built DOM — same house pattern as
 * `fleet-conflicts-view.test.ts` (this repo runs vitest under
 * `environment: "node"`, with no jsdom/happy-dom dependency by house rule),
 * sized to exactly what `skill-trust-badge.ts` uses: createElement, append,
 * textContent, classList, setAttribute/getAttribute. Injected explicitly via
 * `renderSkillTrustBadge`'s optional `doc` parameter rather than stubbing
 * `globalThis.document`.
 */
import { describe, it, expect } from "vitest";
import { renderSkillTrustBadge, trustBadgeLabel } from "../ui/skill-trust-badge";
import type { SkillTrustBadgeData, SkillTrustBadgeStatus } from "../core/skill-trust-service";

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

abstract class FakeNode {
  parentNode: FakeElement | null = null;
}

class FakeTextNode extends FakeNode {
  constructor(public data: string) {
    super();
  }
}

class FakeElement extends FakeNode {
  tagName: string;
  children: FakeNode[] = [];
  private attrs = new Map<string, string>();
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

  appendChild<T extends FakeNode>(node: T): T {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  append(...nodes: Array<FakeNode | string>): void {
    for (const n of nodes) this.appendChild(typeof n === "string" ? new FakeTextNode(n) : n);
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

  /** Direct (non-recursive-selector) element children, in document order. */
  elementChildren(): FakeElement[] {
    return this.children.filter((c): c is FakeElement => c instanceof FakeElement);
  }

  /** Every descendant element, depth-first, regardless of nesting. */
  allDescendantElements(): FakeElement[] {
    const out: FakeElement[] = [];
    for (const c of this.elementChildren()) {
      out.push(c);
      out.push(...c.allDescendantElements());
    }
    return out;
  }

  byClass(cls: string): FakeElement | undefined {
    return this.allDescendantElements().find((el) => el.classList.contains(cls));
  }
}

class FakeDocument {
  createElement(tag: string): FakeElement {
    return new FakeElement(tag);
  }
}

function makeDoc(): { doc: Document; fakeDoc: FakeDocument } {
  const fakeDoc = new FakeDocument();
  return { doc: fakeDoc as unknown as Document, fakeDoc };
}

function asElement(el: HTMLElement): FakeElement {
  return el as unknown as FakeElement;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeData(overrides?: Partial<SkillTrustBadgeData>): SkillTrustBadgeData {
  return {
    name: "code-review",
    status: "active",
    wilsonLower: 0.8123,
    recentBrier: 0.0912,
    n: 14,
    verifiedN: 9,
    ...overrides,
  };
}

const ALL_STATUSES: SkillTrustBadgeStatus[] = ["active", "probation", "demoted", "unscored", "integrity-error"];

// ===========================================================================
// trustBadgeLabel — pure text formatting
// ===========================================================================

describe("trustBadgeLabel", () => {
  it("formats the exact example from the contract", () => {
    const label = trustBadgeLabel(makeData({ status: "active", wilsonLower: 0.8123, recentBrier: 0.0912, n: 14 }));
    expect(label).toBe("active · wilson 0.8123 · brier 0.0912 · n=14");
  });

  it("fixes metrics to exactly 4 decimals even when given fewer/more", () => {
    const label = trustBadgeLabel(makeData({ wilsonLower: 0.5, recentBrier: 0.123456, n: 1 }));
    expect(label).toBe("active · wilson 0.5000 · brier 0.1235 · n=1");
  });

  it("renders null metrics as the words 'no track record', never a dash or a number", () => {
    const label = trustBadgeLabel(makeData({ status: "demoted", wilsonLower: null, recentBrier: null, n: 0 }));
    expect(label).toBe("demoted · wilson no track record · brier no track record · n=0");
    expect(label).not.toMatch(/NaN/);
    expect(label).not.toMatch(/wilson -/);
    expect(label).not.toMatch(/brier -/);
  });

  it("renders one null and one real metric independently", () => {
    const label = trustBadgeLabel(makeData({ status: "unscored", wilsonLower: 0.75, recentBrier: null, n: 3 }));
    expect(label).toBe("unscored · wilson 0.7500 · brier no track record · n=3");
  });

  it.each(ALL_STATUSES)("includes the raw status string %s verbatim", (status) => {
    const label = trustBadgeLabel(makeData({ status }));
    expect(label.startsWith(status)).toBe(true);
  });

  it("never contains the literal string 'null' or 'undefined'", () => {
    const label = trustBadgeLabel(makeData({ wilsonLower: null, recentBrier: null }));
    expect(label).not.toContain("null");
    expect(label).not.toContain("undefined");
  });
});

// ===========================================================================
// renderSkillTrustBadge — DOM structure
// ===========================================================================

describe("renderSkillTrustBadge", () => {
  it("renders a single root element with the base class and no layout assumptions about a parent", () => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData(), doc);
    const fake = asElement(el);
    expect(fake.tagName).toBe("SPAN");
    expect(fake.classList.contains("skill-trust-badge")).toBe(true);
    expect(fake.parentNode).toBeNull();
  });

  it.each(ALL_STATUSES)("assigns the exact per-status class skill-trust-badge--%s", (status) => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData({ status }), doc);
    const fake = asElement(el);
    expect(fake.classList.contains(`skill-trust-badge--${status}`)).toBe(true);
    // No other status class leaked onto the same element.
    for (const other of ALL_STATUSES) {
      if (other === status) continue;
      expect(fake.classList.contains(`skill-trust-badge--${other}`)).toBe(false);
    }
  });

  it("sets data-skill-trust-status to the raw status value", () => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData({ status: "integrity-error" }), doc);
    expect(asElement(el).getAttribute("data-skill-trust-status")).toBe("integrity-error");
  });

  it("carries the trustBadgeLabel text in the rendered metrics/status children via textContent", () => {
    const { doc } = makeDoc();
    const data = makeData({ status: "probation", wilsonLower: 0.6, recentBrier: 0.2, n: 8 });
    const el = renderSkillTrustBadge(data, doc);
    const fake = asElement(el);
    expect(fake.textContent).toContain("probation");
    expect(fake.textContent).toContain("0.6000");
    expect(fake.textContent).toContain("0.2000");
    expect(fake.textContent).toContain("n=8");
  });

  it("renders null metrics as words in the DOM text, never 'null' or 'NaN'", () => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData({ wilsonLower: null, recentBrier: null, n: 0 }), doc);
    const text = asElement(el).textContent;
    expect(text).toContain("no track record");
    expect(text).not.toMatch(/\bnull\b/);
    expect(text).not.toMatch(/\bNaN\b/);
  });

  it("is a single inline-able element with no nested table/list wrapper", () => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData(), doc);
    const fake = asElement(el);
    expect(fake.tagName).toBe("SPAN");
    // Every descendant is also a plain inline span — nothing block-level or
    // otherwise structurally assuming a specific host layout.
    for (const descendant of fake.allDescendantElements()) {
      expect(descendant.tagName).toBe("SPAN");
    }
  });

  it("defaults `doc` to the global document when omitted", () => {
    const previous = (globalThis as { document?: unknown }).document;
    const { doc } = makeDoc();
    (globalThis as { document?: unknown }).document = doc;
    try {
      const el = renderSkillTrustBadge(makeData());
      const fake = asElement(el);
      expect(fake.tagName).toBe("SPAN");
      expect(fake.classList.contains("skill-trust-badge")).toBe(true);
    } finally {
      (globalThis as { document?: unknown }).document = previous;
    }
  });
});

// ===========================================================================
// Hostile input safety
// ===========================================================================

describe("renderSkillTrustBadge — hostile names render inert", () => {
  it("a name containing <script> markup renders as literal inert text, never a real script element", () => {
    const { doc } = makeDoc();
    const hostileName = '<script>window.__pwned = true;</script>';
    const el = renderSkillTrustBadge(makeData({ name: hostileName }), doc);
    const fake = asElement(el);

    // No actual SCRIPT tag was ever created anywhere in the tree.
    expect(fake.allDescendantElements().some((d) => d.tagName === "SCRIPT")).toBe(false);

    // The hostile string shows up only as literal text/attribute data.
    expect(fake.getAttribute("data-skill-name")).toBe(hostileName);
    const nameEl = fake.byClass("skill-trust-badge__name");
    expect(nameEl).toBeDefined();
    expect(nameEl!.textContent).toBe(hostileName);
  });

  it("a name containing control characters round-trips verbatim through textContent", () => {
    const { doc } = makeDoc();
    const hostileName = "weird\u0000name\u0007with\u001bcontrol\nchars";
    const el = renderSkillTrustBadge(makeData({ name: hostileName }), doc);
    const fake = asElement(el);

    expect(fake.getAttribute("data-skill-name")).toBe(hostileName);
    const nameEl = fake.byClass("skill-trust-badge__name");
    expect(nameEl!.textContent).toBe(hostileName);
    // Control characters do not corrupt sibling text nodes.
    const metricsEl = fake.byClass("skill-trust-badge__metrics");
    expect(metricsEl!.textContent).toContain("wilson");
  });

  it("a name containing quotes and ampersands never breaks out of its attribute", () => {
    const { doc } = makeDoc();
    const hostileName = `weird"name'with&<>chars`;
    const el = renderSkillTrustBadge(makeData({ name: hostileName }), doc);
    const fake = asElement(el);
    expect(fake.getAttribute("data-skill-name")).toBe(hostileName);
    expect(fake.getAttribute("aria-label")).toContain(hostileName);
  });

  it("an empty name is handled without throwing and renders an empty (not missing) name node", () => {
    const { doc } = makeDoc();
    const el = renderSkillTrustBadge(makeData({ name: "" }), doc);
    const fake = asElement(el);
    expect(fake.getAttribute("data-skill-name")).toBe("");
    expect(fake.byClass("skill-trust-badge__name")!.textContent).toBe("");
  });
});

// ===========================================================================
// Every status renders distinct, well-formed output
// ===========================================================================

describe("renderSkillTrustBadge — all statuses", () => {
  it.each(ALL_STATUSES)("renders %s without throwing and with a matching aria-label", (status) => {
    const { doc } = makeDoc();
    const data = makeData({ status });
    const el = renderSkillTrustBadge(data, doc);
    const fake = asElement(el);
    expect(fake.getAttribute("aria-label")).toBe(`${data.name}: ${trustBadgeLabel(data)}`);
    expect(fake.getAttribute("title")).toBe(trustBadgeLabel(data));
  });

  it("produces five structurally distinct class sets across all statuses", () => {
    const { doc } = makeDoc();
    const classSets = ALL_STATUSES.map((status) => asElement(renderSkillTrustBadge(makeData({ status }), doc)).className);
    expect(new Set(classSets).size).toBe(ALL_STATUSES.length);
  });
});
