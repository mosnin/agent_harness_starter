import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SpatialContextStore,
  validateSpatialImage,
  type SpatialScope,
} from "../core/spatial-context";
import { HelmHandoffStore } from "../core/helm-handoff";
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
let dir: string, store: SpatialContextStore, scope: SpatialScope;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "spatial-test-")));
  scope = { sessionId: "thread", profile: "p", root: dir };
  store = new SpatialContextStore(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const create = () =>
  store.create(scope, {
    source: "browser",
    title: "Button",
    context: {
      tabId: "tab",
      workspaceId: "space",
      url: "http://localhost:3000/",
      zoomFactor: 1,
      viewport: { width: 100, height: 200 },
      semantics: { role: "button", name: "Save" },
      styles: { gap: "8px" },
    },
    images: [image],
  });
describe("spatial capture authority and revisions", () => {
  it("persists local captures and rejects every cross-scope read", () => {
    const p = create();
    store = new SpatialContextStore(dir);
    expect(store.get(p.id, scope)).toEqual(p);
    for (const key of ["sessionId", "profile", "root"])
      expect(() => store.get(p.id, { ...scope, [key]: "other" })).toThrow(
        /own/,
      );
    expect(store.list({ ...scope, sessionId: "other" })).toEqual([]);
    expect(store.list(scope)[0].images).toBeUndefined();
    expect(statSync(join(dir, "spatial", p.id + ".json")).mode & 0o777).toBe(
      0o600,
    );
    expect(() => store.get("../../anything", scope)).toThrow(/identifier/);
  });
  it("requires explicit review and binds sharing to the exact reviewed revision", async () => {
    const p = create();
    expect(() =>
      store.prepare([{ id: p.id, revision: p.revision }], scope),
    ).toThrow(/Review/);
    const reviewed = await store.review(p, scope, {
      intent: "Align this button",
    });
    expect(() => store.prepare([p], scope)).toThrow(/revision/);
    const prepared = store.attach([reviewed], scope);
    expect(prepared.images).toEqual([image]);
    expect(prepared.context).toContain("untrusted");
    expect(store.get(p.id, scope).status).toBe("attached");
    await expect(
      store.review(reviewed, scope, { intent: "Changed" }),
    ).rejects.toThrow(/already shared/);
  });
  it("physically excludes images and structural text from saved and dispatched packets", async () => {
    const p = create(),
      reviewed = await store.review(p, scope, {
        intent: "Use this annotation only",
        excludeImage: true,
        excludeText: true,
      });
    const saved = readFileSync(join(dir, "spatial", p.id + ".json"), "utf8");
    expect(saved).not.toContain("iVBOR");
    expect(saved).not.toContain("localhost");
    expect(store.prepare([reviewed], scope).images).toEqual([]);
    expect(reviewed.context).toEqual({});
  });
  it("region masking uses native pixels and removes hidden OCR/text context", async () => {
    const processor = vi.fn(async () => ({ image }));
    store = new SpatialContextStore(dir, processor);
    const p = create(),
      redactions = [{ x: 0, y: 0, width: 0.5, height: 0.5 }];
    const reviewed = await store.review(p, scope, {
      intent: "Redacted",
      redactions,
    });
    expect(processor).toHaveBeenCalledWith("redact", [image], redactions);
    expect(reviewed.context).toEqual({});
    expect(reviewed.review?.excludeText).toBe(true);
    await expect(
      store.review(reviewed, scope, {
        intent: "Invalid",
        redactions: [{ x: 0.9, y: 0, width: 0.5, height: 1 }],
      }),
    ).rejects.toThrow(/rectangles/);
  });
  it("a failed image operation does not partially save the review", async () => {
    store = new SpatialContextStore(dir, async () => {
      throw new Error("Helper unavailable");
    });
    const p = create();
    await expect(
      store.review(p, scope, {
        intent: "Mask",
        redactions: [{ x: 0, y: 0, width: 1, height: 1 }],
      }),
    ).rejects.toThrow(/unavailable/);
    expect(store.get(p.id, scope)).toEqual(p);
  });
  it("rejects malformed images, duplicate attachments and changed storage", async () => {
    expect(() => validateSpatialImage("data:image/png;base64,a===")).toThrow();
    const p = await store.review(create(), scope, { intent: "Align" });
    expect(() => store.prepare([p, p], scope)).toThrow(/distinct/);
    const path = join(dir, "spatial", p.id + ".json");
    writeFileSync(path, JSON.stringify({ ...p, intent: "tampered" }));
    expect(() => store.get(p.id, scope)).toThrow(/integrity/);
  });
  it("blocks concurrent review and stale completion", async () => {
    let finish!: (value: any) => void;
    store = new SpatialContextStore(
      dir,
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    const p = create();
    const pending = store.review(p, scope, {
      intent: "Mask",
      redactions: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    });
    await expect(store.review(p, scope, { intent: "Another" })).rejects.toThrow(
      /already/,
    );
    expect(() => store.prepare([p], scope)).toThrow(/finish/);
    expect(() => store.remove(p, scope)).toThrow(/finish/);
    finish({ image });
    await pending;
    await expect(store.review(p, scope, { intent: "Old" })).rejects.toThrow(
      /changed/,
    );
  });
  it("deletes only the owned unshared current revision and removes its saved image and index", async () => {
    const p = create(),
      reviewed = await store.review(p, scope, { intent: "Review" });
    expect(() =>
      store.remove(reviewed, { ...scope, sessionId: "another" }),
    ).toThrow(/own/);
    expect(() => store.remove(p, scope)).toThrow(/changed/);
    expect(store.remove(reviewed, scope)).toEqual({ removed: true, id: p.id });
    expect(store.list(scope)).toEqual([]);
    expect(() => store.get(p.id, scope)).toThrow(/not found/);
    const shared = await store.review(create(), scope, {
      intent: "Retain shared evidence",
    });
    store.attach([shared], scope);
    expect(() => store.remove(shared, scope)).toThrow(/retained/);
  });
});
describe("comparison and coding handoff", () => {
  it("refuses comparison across viewport or tab identity and reports exact style changes", async () => {
    const a = create(),
      b = store.create(scope, {
        source: "browser",
        title: "After",
        context: { ...a.context, styles: { gap: "16px" } },
        images: [image],
      });
    const result = await store.compare(a.id, b.id, scope);
    expect(result.comparable).toBe(true);
    expect(result.changes).toContainEqual({
      path: "styles.gap",
      before: "8px",
      after: "16px",
    });
    const other = store.create(scope, {
      source: "browser",
      title: "Wrong viewport",
      context: { ...a.context, viewport: { width: 300, height: 200 } },
    });
    expect((await store.compare(a.id, other.id, scope)).reasons).toContain(
      "Capture viewport differs",
    );
  });
  it("spatial draft is idempotent and cannot be started in another project/profile", async () => {
    const p = await store.review(create(), scope, { intent: "Fix spacing" }),
      handoffs = new HelmHandoffStore(dir);
    const request = {
      requestId: p.id,
      prompt: "Fix spacing",
      notebook: {
        id: p.id,
        workspaceId: "space",
        title: p.title,
        body: "Reviewed capture",
        sources: [],
      },
    };
    const ref = { id: p.id, revision: p.revision };
    const draft = handoffs.receiveSpatial(request, scope, ref);
    expect(handoffs.receiveSpatial(request, scope, ref)).toEqual(draft);
    expect(() =>
      handoffs.claim(draft.id, { root: dir, owner: "other" }),
    ).toThrow(/profile/);
    store.bindHandoff(ref, scope, draft.id);
    await expect(
      store.review(ref, scope, { intent: "Secret change" }),
    ).rejects.toThrow(/shared/);
    expect(handoffs.claim(draft.id, { root: dir, owner: "p" }).status).toBe(
      "starting",
    );
  });
});
