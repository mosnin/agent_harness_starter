/**
 * Workspace surface tests: the pure `state-view.ts` renderer, and the
 * renderer-level wiring that makes it (and the real keymap engine) reachable
 * in the running app.
 *
 * The injection cases are the point of the attribute-escaping work: a
 * workspace key is FOREIGN data written by another process, and `validateKey`
 * (`src/hades/state/record.ts`) permits quotes in one — so a key crafted to
 * break out of an attribute must not be able to.
 */
import { describe, it, expect } from "vitest";

import { renderStateView, filterRecords, initialStateViewState, isStateViewDomain } from "../ui/state-view";
import { initialStateSlice, reduceState } from "../core/state-slice";
import type { StateSlice } from "../core/state-slice";
import { createApp } from "../ui/renderer";
import type { Bridge } from "../ui/renderer";
import type { AppEvent, Command } from "../ipc/contract";
import type { WorkspaceRecordView } from "../ipc/state-contract";

function record(over: Partial<WorkspaceRecordView> = {}): WorkspaceRecordView {
  return {
    domain: "memory",
    key: "alpha",
    rev: 1,
    updatedAt: 1_700_000_000_000,
    actor: "cli:term-1",
    deleted: false,
    hash: "0123456789abcdef",
    value: { text: "hello" },
    ...over,
  };
}

function sliceWith(records: WorkspaceRecordView[]): StateSlice {
  return reduceState(initialStateSlice(), { kind: "state.records", domain: "memory", records }, () => 0);
}

function makeFakeBridge() {
  const sent: Command[] = [];
  let handler: ((e: AppEvent) => void) | null = null;
  const bridge: Bridge = {
    send(cmd) {
      sent.push(cmd);
    },
    onEvent(cb) {
      handler = cb;
      return () => {
        handler = null;
      };
    },
    async start() {},
    async stop() {
      handler = null;
    },
  };
  return { bridge, sent, push: (e: AppEvent) => handler?.(e) };
}

// ---------------------------------------------------------------------------
// Pure renderer
// ---------------------------------------------------------------------------

describe("renderStateView", () => {
  it("renders real records with their real actor attribution", () => {
    const html = renderStateView(sliceWith([record()]), initialStateViewState());
    expect(html).toContain("cli:term-1");
    expect(html).toContain("alpha");
    expect(html).toContain("hello");
    expect(html).toContain('data-testid="state-table"');
  });

  it("says so honestly when there is no status and no records", () => {
    const html = renderStateView(initialStateSlice(), initialStateViewState());
    expect(html).toContain("has not answered");
    expect(html).toContain('data-testid="state-empty"');
    // No fabricated zeros presented as a real reading.
    expect(html).not.toContain('data-testid="state-table"');
  });

  it("distinguishes 'no records' from 'filter hides them all'", () => {
    const slice = sliceWith([record({ key: "alpha" })]);
    const filtered = renderStateView(slice, { domain: "memory", filter: "zzz" });
    expect(filtered).toContain("matches that filter");
    expect(filtered).toContain("1 record(s) hidden");

    const empty = renderStateView(initialStateSlice(), initialStateViewState());
    expect(empty).toContain("No records in");
  });

  it("renders a broken hash chain loudly rather than smoothing it over", () => {
    const slice = reduceState(
      initialStateSlice(),
      {
        kind: "state.status",
        status: {
          root: "/w/state",
          actor: "desktop:d1",
          journalSeq: 4,
          head: "deadbeefcafebabe",
          chainOk: false,
          perDomain: [{ domain: "memory", records: 1, lastUpdatedAt: 5 }],
          lastSyncAt: null,
          conflicts: 0,
        },
      },
      () => 0,
    );
    const html = renderStateView(slice, initialStateViewState());
    expect(html).toContain("CHAIN BROKEN");
    expect(html).toContain("state-chip--bad");
    // Never-synced reports "never", not epoch 0 dressed up as a timestamp.
    expect(html).toContain("never");
  });

  it("marks a tombstone as a tombstone instead of rendering null as a value", () => {
    const html = renderStateView(
      sliceWith([record({ key: "gone", deleted: true, hash: "", value: null })]),
      initialStateViewState(),
    );
    expect(html).toContain("(tombstone)");
    expect(html).toContain("state-row--deleted");
  });

  it("escapes a hostile key in BOTH text and attribute contexts", () => {
    const hostile = 'evil" onmouseover="alert(1)';
    const html = renderStateView(sliceWith([record({ key: hostile })]), initialStateViewState());
    // The raw attribute-breaking sequence must not survive anywhere.
    expect(html).not.toContain('onmouseover="alert(1)"');
    expect(html).not.toContain('="evil" onmouseover');
    expect(html).toContain("&quot;");
    expect(html).toContain('data-key="evil&quot; onmouseover=&#39;alert(1)'.slice(0, 20));
  });

  it("escapes hostile markup in a record value and in an actor id", () => {
    const html = renderStateView(
      sliceWith([record({ value: { x: "<script>alert(1)</script>" }, actor: "cli:<img src=x>" })]),
      initialStateViewState(),
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("abbreviates a long value visibly rather than pretending it is complete", () => {
    const long = "x".repeat(500);
    const html = renderStateView(sliceWith([record({ value: long })]), initialStateViewState());
    expect(html).toContain("…");
    expect(html).not.toContain("x".repeat(200));
  });
});

describe("filterRecords", () => {
  it("sorts by key and filters case-insensitively on the key only", () => {
    const rows = [record({ key: "Beta" }), record({ key: "alpha" }), record({ key: "gamma", value: "beta" })];
    expect(filterRecords(rows, "").map((r) => r.key)).toEqual(["Beta", "alpha", "gamma"]);
    expect(filterRecords(rows, "BET").map((r) => r.key)).toEqual(["Beta"]);
    // The value contains "beta" but the filter is key-only — no silent widening.
    expect(filterRecords(rows, "beta").map((r) => r.key)).toEqual(["Beta"]);
  });

  it("never mutates its input", () => {
    const rows = [record({ key: "b" }), record({ key: "a" })];
    const before = rows.map((r) => r.key);
    filterRecords(rows, "");
    expect(rows.map((r) => r.key)).toEqual(before);
  });
});

describe("isStateViewDomain", () => {
  it("accepts exactly the four workspace domains", () => {
    for (const d of ["sessions", "memory", "config", "skills"]) expect(isStateViewDomain(d)).toBe(true);
    for (const d of ["", "Memory", "../etc", "state"]) expect(isStateViewDomain(d)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Renderer wiring
// ---------------------------------------------------------------------------

describe("createApp — Workspace surface", () => {
  it("turns the live feed on when entering and off when leaving", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge);

    app.setNav("state");
    expect(sent).toContainEqual({ kind: "state.watch", enabled: true });
    expect(sent).toContainEqual({ kind: "state.status" });
    expect(sent).toContainEqual({ kind: "state.list", domain: "memory" });

    sent.length = 0;
    app.setNav("run");
    expect(sent).toContainEqual({ kind: "state.watch", enabled: false });
    // Leaving must not keep polling for a surface nobody is looking at.
    expect(sent.some((c) => c.kind === "state.list")).toBe(false);
  });

  it("loads real data when the app opens directly on the Workspace surface", () => {
    const { bridge, sent } = makeFakeBridge();
    createApp(bridge, { initialNav: "state" });
    expect(sent).toContainEqual({ kind: "state.watch", enabled: true });
    expect(sent).toContainEqual({ kind: "state.status" });
    expect(sent).toContainEqual({ kind: "state.list", domain: "memory" });
  });

  it("does not send a state.watch(false) when it was never on", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge);
    app.setNav("metrics");
    expect(sent.some((c) => c.kind === "state.watch")).toBe(false);
  });

  it("reduces real state events into the slice and renders them", () => {
    const { bridge, push } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });

    push({
      kind: "state.records",
      domain: "memory",
      records: [record({ key: "from-the-wire", value: { note: "live" } })],
    });

    expect(app.getStateSlice().byDomain.memory).toHaveLength(1);
    const html = app.html();
    expect(html).toContain("from-the-wire");
    expect(html).toContain("live");
  });

  it("upserts a state.changed delta authored by another surface", () => {
    const { bridge, push } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });

    push({ kind: "state.records", domain: "memory", records: [record({ key: "k", rev: 1 })] });
    push({
      kind: "state.changed",
      seq: 9,
      actor: "cli:other-terminal",
      records: [record({ key: "k", rev: 2, value: { text: "updated elsewhere" } })],
    });

    const slice = app.getStateSlice();
    expect(slice.byDomain.memory).toHaveLength(1);
    expect(slice.byDomain.memory[0].rev).toBe(2);
    expect(slice.lastChangeSeq).toBe(9);
    expect(app.html()).toContain("cli:other-terminal");
  });

  it("switching domain re-lists and re-renders, filtering stays local", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });

    sent.length = 0;
    app.dispatchIntent({ cmd: "state.domain", value: "config" });
    expect(sent).toEqual([{ kind: "state.list", domain: "config" }]);

    sent.length = 0;
    app.dispatchIntent({ cmd: "state.filter", value: "loc" });
    // A filter is renderer-local view state — it must never hit the store.
    expect(sent).toEqual([]);
    expect(app.html()).toContain('value="loc"');
  });

  it("ignores an unknown domain rather than sending a bogus command", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });
    sent.length = 0;
    app.dispatchIntent({ cmd: "state.domain", value: "../etc/passwd" });
    expect(sent).toEqual([]);
  });

  it("delete and sync send real wire commands for the selected domain", () => {
    const { bridge, sent } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });
    app.dispatchIntent({ cmd: "state.domain", value: "config" });

    sent.length = 0;
    app.dispatchIntent({ cmd: "state.delete", value: "locale" });
    expect(sent[0]).toEqual({ kind: "state.delete", domain: "config", key: "locale" });

    sent.length = 0;
    app.dispatchIntent({ cmd: "state.sync.plan" });
    expect(sent).toEqual([{ kind: "state.sync", dryRun: true }]);

    sent.length = 0;
    app.dispatchIntent({ cmd: "state.sync" });
    expect(sent[0]).toEqual({ kind: "state.sync" });
  });

  it("surfaces a state.error instead of silently swallowing it", () => {
    const { bridge, push } = makeFakeBridge();
    const app = createApp(bridge, { initialNav: "state" });
    push({ kind: "state.error", op: "state.sync", message: "sync is not configured" });
    const html = app.html();
    expect(html).toContain('data-testid="state-error"');
    expect(html).toContain("sync is not configured");
  });
});
