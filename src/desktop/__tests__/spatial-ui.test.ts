// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { SpatialView, type SpatialPacket } from "../ui/spatial";
const scope = { sessionId: "s1", profile: "p1", root: "/project" };
const packet: SpatialPacket = {
  ...scope,
  id: "capture1",
  createdAt: 1,
  title: "Checkout",
  intent: "Fix the button",
  source: "desktop",
  context: { text: "private" },
  image: "data:image/png;base64,YQ==",
  status: "captured",
  digest: "digest",
  revision: 1,
};
let host: HTMLDivElement;
let view: SpatialView;
const rpc = vi.fn(
  async (method: string, args?: Record<string, unknown>): Promise<any> => {
    if (method === "spatial.status")
      return {
        desktop: { available: true },
        browser: { available: false, reason: "Open Hades Browser" },
      };
    if (method === "spatial.list") return [];
    if (method === "spatial.get") return { ...packet, id: args?.id };
    if (method === "spatial.capture") return { ...packet };
    if (method === "spatial.review")
      return {
        ...packet,
        status: "reviewed",
        revision: 2,
        intent: args?.intent,
        image: args?.excludeImage ? undefined : packet.image,
        context: args?.excludeText ? {} : packet.context,
        review: {
          excludeImage: args?.excludeImage,
          excludeText: args?.excludeText,
        },
      };
    if (method === "spatial.handoff") return { id: "draft1", status: "draft" };
    if (method === "spatial.compare")
      return {
        beforeId: "capture1",
        afterId: "capture2",
        comparable: false,
        reasons: ["Different windows"],
        imageChanged: true,
        contextChanged: true,
        changes: [{ path: "title", before: "A", after: "B" }],
      };
  },
);
const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const click = async (action: string) => {
  host.querySelector<HTMLButtonElement>(`[data-spatial="${action}"]`)!.click();
  await flush();
};
const input = (id: string, value: string) => {
  const el = host.querySelector<HTMLInputElement>(`#${id}`)!;
  el.value = value;
  el.dispatchEvent(new Event("input"));
};
const capture = async () => {
  await view.open();
  await click("capture");
};
beforeEach(() => {
  rpc.mockClear();
  document.body.innerHTML = "";
  host = document.createElement("div");
  document.body.append(host);
  view = new SpatialView(rpc, vi.fn());
  view.setScope(scope);
  view.mount(host);
});
it("captures locally, saves exclusions, attaches exact revision without dispatch", async () => {
  await capture();
  expect(
    host.querySelector('[data-spatial="attach"]')?.hasAttribute("disabled"),
  ).toBe(true);
  input("spatial-intent", "Annotated privately");
  const checkbox = host.querySelector<HTMLInputElement>(
    "#spatial-exclude-image",
  )!;
  checkbox.checked = true;
  checkbox.dispatchEvent(new Event("change"));
  expect(host.querySelector("img")).toBeNull();
  await click("review");
  await click("attach");
  expect(view.attachments).toEqual([{ id: "capture1", revision: 2 }]);
  expect(
    rpc.mock.calls.find(([name]) => name === "spatial.review")?.[1],
  ).toMatchObject({
    ...scope,
    revision: 1,
    intent: "Annotated privately",
    excludeImage: true,
  });
  expect(
    rpc.mock.calls.some(
      ([name]) => name === "chat.send" || name === "helm.start",
    ),
  ).toBe(false);
  input("spatial-intent", "New unsaved annotation");
  expect(view.attachments).toEqual([]);
});
it("ignores pending capture after session switch and restores local review draft", async () => {
  await capture();
  input("spatial-intent", "Do not lose this");
  let resolve!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  host.querySelector<HTMLButtonElement>('[data-spatial="capture"]')!.click();
  view.setScope({ ...scope, sessionId: "s2" });
  view.mount(host);
  resolve(packet);
  await flush();
  expect(host.textContent).not.toContain("Checkout");
  expect(view.attachments).toEqual([]);
  view.setScope(scope);
  view.mount(host);
  expect(
    host.querySelector<HTMLTextAreaElement>("#spatial-intent")?.value,
  ).toBe("Do not lose this");
});
it("dismisses pending work without attaching or dispatching a late result", async () => {
  await view.open();
  let resolve!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  host.querySelector<HTMLButtonElement>('[data-spatial="capture"]')!.click();
  await click("close");
  resolve(packet);
  await flush();
  expect(host.querySelector(".spatial-panel")).toBeNull();
  expect(view.attachments).toEqual([]);
});
it("preserves coding prompt across errors and requires explicit Helm draft creation", async () => {
  await capture();
  await click("review");
  input("spatial-prompt", "Repair checkout");
  rpc.mockImplementationOnce(async () => {
    throw new Error("Connection unavailable. Open Settings.");
  });
  await click("handoff");
  expect(host.querySelector("[role=alert]")?.textContent).toContain(
    "Open Settings",
  );
  expect(
    host.querySelector<HTMLTextAreaElement>("#spatial-prompt")?.value,
  ).toBe("Repair checkout");
  await click("handoff");
  expect(host.textContent).toContain("draft1");
  expect(rpc.mock.calls.some(([name]) => name === "helm.start")).toBe(false);
});
it("rejects cross-project capture responses", async () => {
  await view.open();
  rpc.mockImplementationOnce(async () => ({ ...packet, root: "/other" }));
  await click("capture");
  expect(host.querySelector("[role=alert]")?.textContent).toContain(
    "different conversation",
  );
  expect(host.querySelector("article")).toBeNull();
});
it("renders before-after scope differences without claiming success", async () => {
  rpc.mockImplementationOnce(async () => ({}));
  rpc.mockImplementationOnce(async () => [
    packet,
    { ...packet, id: "capture2", title: "After" },
  ]);
  await view.open();
  const select = host.querySelector<HTMLSelectElement>("#spatial-packet")!;
  select.value = "capture1";
  select.dispatchEvent(new Event("change"));
  await flush();
  input("spatial-after", "capture2");
  await click("compare");
  expect(host.textContent).toContain("Different capture scopes");
  expect(host.textContent).toContain("not proof that the task is correct");
});
it("uses observed browser tab and element refs and supports latest Maus import", async () => {
  await view.open();
  input("spatial-source", "browser");
  rpc.mockImplementationOnce(async () => ({
    tabs: [{ id: "tab1", title: "Checkout" }],
  }));
  await click("targets");
  const tab = host.querySelector<HTMLSelectElement>("#spatial-tab")!;
  tab.value = "tab1";
  tab.dispatchEvent(new Event("change"));
  rpc.mockImplementationOnce(async () => ({
    tabs: [{ id: "tab1", title: "Checkout" }],
    snapshot: {
      snapshotId: 1048577,
      nodes: [{ ref: "ref1", role: "button", name: "Pay" }],
    },
  }));
  await click("targets");
  const element = host.querySelector<HTMLSelectElement>("#spatial-element")!;
  element.value = "ref1";
  element.dispatchEvent(new Event("change"));
  await click("capture");
  expect(
    rpc.mock.calls.find(([method]) => method === "spatial.capture")?.[1],
  ).toMatchObject({
    source: "browser",
    tabId: "tab1",
    ref: "ref1",
    snapshotId: 1048577,
  });
  input("spatial-source", "maus-latest");
  await click("capture");
  expect(
    rpc.mock.calls
      .filter(([method]) => method === "spatial.capture")
      .at(-1)?.[1],
  ).toMatchObject({ source: "maus", mode: "latest" });
});
it("drops stale attachments and refreshes clean review text when revision changes", async () => {
  await capture();
  await click("review");
  await click("attach");
  rpc.mockImplementationOnce(async () => ({}));
  rpc.mockImplementationOnce(async () => [
    { ...packet, status: "reviewed", revision: 3, intent: "Updated elsewhere" },
  ]);
  rpc.mockImplementationOnce(async () => ({
    ...packet,
    status: "reviewed",
    revision: 3,
    intent: "Updated elsewhere",
  }));
  await click("refresh");
  expect(view.attachments).toEqual([]);
  expect(
    host.querySelector<HTMLTextAreaElement>("#spatial-intent")?.value,
  ).toBe("Updated elsewhere");
});
it("supports keyboard-entered normalized masks and excludes structural text", async () => {
  await capture();
  input("spatial-mask-x", "10");
  input("spatial-mask-y", "20");
  input("spatial-mask-width", "30");
  input("spatial-mask-height", "40");
  await click("mask-add");
  expect(host.querySelector(".spatial-image i")).not.toBeNull();
  expect(
    host.querySelector<HTMLInputElement>("#spatial-exclude-text")?.checked,
  ).toBe(true);
  await click("review");
  expect(
    rpc.mock.calls.find(([method]) => method === "spatial.review")?.[1],
  ).toMatchObject({
    excludeText: true,
    redactions: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }],
  });
});
it("rejects out-of-image masks without saving them", async () => {
  await capture();
  input("spatial-mask-x", "95");
  input("spatial-mask-width", "20");
  await click("mask-add");
  expect(host.querySelector("[role=alert]")?.textContent).toContain(
    "inside the image",
  );
  expect(rpc.mock.calls.some(([method]) => method === "spatial.review")).toBe(
    false,
  );
});
it("records workflows explicitly and reconciles unknown replay without automatic retry", async () => {
  await view.open();
  input("spatial-source", "browser");
  rpc.mockImplementationOnce(async () => ({
    tabs: [{ id: "tab1", title: "Checkout" }],
  }));
  await click("targets");
  const tab = host.querySelector<HTMLSelectElement>("#spatial-tab")!;
  tab.value = "tab1";
  tab.dispatchEvent(new Event("change"));
  rpc.mockImplementationOnce(async () => ({
    workflows: [{ id: "w1", status: "recording", steps: [] }],
  }));
  await click("workflow-start");
  expect(
    rpc.mock.calls.find(([method]) => method === "spatial.workflow")?.[1],
  ).toMatchObject({
    ...scope,
    tabId: "tab1",
    operation: "start",
    mode: "human",
  });
  rpc.mockImplementationOnce(async () => {
    throw new Error("Connection lost");
  });
  await click("workflow-replay");
  expect(host.textContent).toContain("unknown result");
  expect(
    host
      .querySelector('[data-spatial="workflow-replay"]')
      ?.hasAttribute("disabled"),
  ).toBe(true);
  expect(
    rpc.mock.calls.filter(
      ([method, args]) =>
        method === "spatial.workflow" && args?.operation === "replay",
    ),
  ).toHaveLength(1);
});
it("prefers available Maus and loads lightweight capture details on selection", async () => {
  rpc.mockImplementationOnce(async () => ({ maus: { available: true } }));
  rpc.mockImplementationOnce(async () => [{ ...packet, image: undefined }]);
  await view.open();
  expect(host.querySelector<HTMLSelectElement>("#spatial-source")?.value).toBe(
    "maus",
  );
  const select = host.querySelector<HTMLSelectElement>("#spatial-packet")!;
  select.value = "capture1";
  select.dispatchEvent(new Event("change"));
  await flush();
  expect(rpc.mock.calls.some(([method]) => method === "spatial.get")).toBe(
    true,
  );
  expect(host.querySelector("img")).not.toBeNull();
});
it("cancels pending captures with their original scope on close and scope change", async () => {
  await view.open();
  let resolve!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
  host.querySelector<HTMLButtonElement>('[data-spatial="capture"]')!.click();
  view.setScope({ ...scope, sessionId: "s2" });
  view.mount(host);
  await flush();
  expect(
    rpc.mock.calls.find(([method]) => method === "spatial.cancel")?.[1],
  ).toEqual(scope);
  resolve(packet);
  await flush();
  expect(view.attachments).toEqual([]);
});
it("confirms deletion, keeps capture on cancel, and resets selection after delete", async () => {
  await capture();
  await click("delete");
  expect(rpc.mock.calls.some(([method]) => method === "spatial.remove")).toBe(
    false,
  );
  await click("delete-cancel");
  expect(
    host.querySelector('[aria-label="Confirm capture deletion"]'),
  ).toBeNull();
  expect(host.querySelector("article")).not.toBeNull();
  await click("delete");
  await click("delete-confirm");
  expect(
    rpc.mock.calls.find(([method]) => method === "spatial.remove")?.[1],
  ).toEqual({ ...scope, id: packet.id, revision: 1 });
  expect(host.querySelector("article")).toBeNull();
  expect(view.attachments).toEqual([]);
  expect(host.textContent).toContain("Capture deleted");
});
it("prevents deleting a composer attachment and clears confirmation when closed", async () => {
  await capture();
  await click("delete");
  await click("close");
  view.mount(host);
  await view.open();
  expect(
    host.querySelector('[aria-label="Confirm capture deletion"]'),
  ).toBeNull();
  await click("capture");
  await click("review");
  await click("attach");
  expect(
    host.querySelector('[data-spatial="delete"]')?.hasAttribute("disabled"),
  ).toBe(true);
  await click("delete");
  expect(rpc.mock.calls.some(([method]) => method === "spatial.remove")).toBe(
    false,
  );
});
it("distinguishes missing comparisons from unchanged results", async () => {
  rpc.mockImplementationOnce(async () => ({}));
  rpc.mockImplementationOnce(async () => [
    packet,
    { ...packet, id: "capture2", title: "After" },
  ]);
  await view.open();
  const select = host.querySelector<HTMLSelectElement>("#spatial-packet")!;
  select.value = "capture1";
  select.dispatchEvent(new Event("change"));
  await flush();
  input("spatial-after", "capture2");
  rpc.mockImplementationOnce(async () => ({ ...packet, id: "capture2" }));
  rpc.mockImplementationOnce(async () => ({
    beforeId: packet.id,
    afterId: "capture2",
    comparable: false,
    reasons: ["No matched pixels"],
    imageChanged: null,
    contextChanged: null,
    changes: [],
  }));
  await click("compare");
  expect(host.textContent).toContain("Image not compared");
  expect(host.textContent).toContain("Context not compared");
  expect(host.textContent).not.toContain("Image unchanged");
  expect(host.textContent).not.toContain("Context unchanged");
});
