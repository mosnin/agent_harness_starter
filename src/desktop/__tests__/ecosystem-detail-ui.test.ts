// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CompanyOsSettingsView,
  EcosystemPluginsView,
  type PluginView,
  type PluginData,
} from "../ui/ecosystem-plugins";
import type { PluginAccount, PluginRecord } from "../core/ecosystem-types";
const a: PluginAccount = {
    id: "human-a",
    tenantId: "tenant-a",
    name: "Workspace A",
  },
  b: PluginAccount = {
    id: "human-b",
    tenantId: "tenant-b",
    name: "Workspace B",
  };
const record = (title = "Saved index"): PluginRecord => ({
  id: "doc",
  collection: "document",
  title,
  revision: "1",
  data: { title: "Index only" },
});
const plugin = (account = a): PluginView => ({
  id: "company-os",
  name: "Company OS",
  origin: "https://www.companyos.sh",
  description: "Company documents",
  status: "connected",
  account,
  collections: ["document"],
  agentRead: true,
  agentWrite: true,
  scopes: ["companyos:data:read", "companyos:data:write"],
  syncMode: "live",
});
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const settle = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};
let host: HTMLElement, view: EcosystemPluginsView, state: PluginView;
let rpc: ReturnType<
  typeof vi.fn<(method: string, args?: Record<string, unknown>) => Promise<any>>
>;
let detail: ReturnType<
  typeof deferred<{
    record: PluginRecord;
    account: PluginAccount;
    source: string;
  }>
>;
const button = (id: string) =>
  host.querySelector<HTMLButtonElement>("#ecosystem-" + id)!;
const fields = () =>
  host.querySelector('pre[aria-label="Record fields"]')?.textContent;
beforeEach(async () => {
  document.body.innerHTML = "<main></main>";
  host = document.querySelector("main")!;
  state = plugin();
  detail = deferred();
  rpc = vi.fn(async (method, args) => {
    if (method === "ecosystem.list") return [structuredClone(state)];
    if (method === "ecosystem.data")
      return {
        records: [
          record(state.account?.id === "human-b" ? "B index" : "Saved index"),
        ],
        collections: ["document"],
        total: 1,
        status: state.status,
        account: state.account,
      } satisfies PluginData;
    if (method === "ecosystem.record") return detail.promise;
    if (method === "ecosystem.permissions") {
      state = {
        ...state,
        agentRead: args!.agentRead as boolean,
        agentWrite: args!.agentWrite as boolean,
      };
      return state;
    }
    return {};
  });
  view = new EcosystemPluginsView(
    rpc,
    async () => {},
    async () => {},
  );
  view.mount(host);
  await view.open("profile-a", "company-os");
});
afterEach(() => {
  view.dispose();
  document.body.replaceChildren();
});
it("loads scoped complete service content and expands the remaining escaped fields", async () => {
  button("record-0").click();
  expect(rpc).toHaveBeenLastCalledWith("ecosystem.record", {
    profile: "profile-a",
    pluginId: "company-os",
    collection: "document",
    id: "doc",
  });
  expect(host.textContent).toContain("Loading record");
  expect(fields()).toContain("Index only");
  const content =
    "<script>never execute</script>" +
    "z".repeat(40000) +
    "END OF FULL CONTENT";
  detail.resolve({
    record: { ...record("Service document"), revision: "2", data: { content } },
    account: a,
    source: "service",
  });
  await settle();
  expect(host.textContent).toContain("Read from the connected service");
  expect(fields()).not.toContain("END OF FULL CONTENT");
  button("more-fields").focus();
  button("more-fields").click();
  expect(host.contains(document.activeElement)).toBe(true);
  expect(fields()).toContain("END OF FULL CONTENT");
  expect(fields()).toContain("<script>never execute</script>");
  expect(host.querySelector("script")).toBeNull();
  expect(button("more-fields")).toBeNull();
  expect(host.textContent).toContain("Service document");
});
it("refuses a foreign account detail response and retains only the original saved fields", async () => {
  button("record-0").click();
  detail.resolve({
    record: { ...record(), data: { content: "FOREIGN SECRET" } },
    account: b,
    source: "service",
  });
  await settle();
  expect(host.textContent).toContain("Record identity changed");
  expect(fields()).toContain("Index only");
  expect(host.textContent).not.toContain("FOREIGN SECRET");
});
it("ignores late detail data after switching profiles", async () => {
  button("record-0").click();
  state = plugin(b);
  await view.open("profile-b", "company-os");
  detail.resolve({
    record: { ...record(), data: { content: "OLD PROFILE SECRET" } },
    account: a,
    source: "service",
  });
  await settle();
  expect(host.textContent).toContain("Workspace B");
  expect(host.textContent).toContain("B index");
  expect(host.textContent).not.toContain("OLD PROFILE SECRET");
  expect(host.querySelector("#ecosystem-detail pre")).toBeNull();
});
it("ignores late detail errors after unmount and remount to another profile", async () => {
  button("record-0").click();
  view.mount(undefined);
  state = plugin(b);
  view.mount(host);
  await view.open("profile-b", "company-os");
  detail.reject(Error("Old account failure"));
  await settle();
  expect(host.textContent).not.toContain("Old account failure");
  expect(host.textContent).toContain("Workspace B");
});
it("keeps selected content and keyboard focus through metadata pushes without duplicate IDs", async () => {
  button("record-0").click();
  detail.resolve({
    record: {
      ...record("Selected document"),
      data: { content: "Keep this detail" },
    },
    account: a,
    source: "service",
  });
  await settle();
  button("close-detail").focus();
  const dataCalls = rpc.mock.calls.filter(
    ([m]) => m === "ecosystem.data",
  ).length;
  state = {
    ...state,
    syncMode: "changes",
    status: "stale",
    lastSyncedAt: 1700000000000,
  };
  view.changed();
  await settle();
  view.changed();
  await settle();
  expect(fields()).toContain("Keep this detail");
  expect(document.activeElement?.id).toBe("ecosystem-close-detail");
  expect(host.textContent).toContain("Change feed");
  expect(host.textContent).toContain("Account sync status changed");
  expect(rpc.mock.calls.filter(([m]) => m === "ecosystem.data")).toHaveLength(
    dataCalls,
  );
  const ids = [...host.querySelectorAll("[id]")].map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);
  button("refresh-data").click();
  await settle();
  expect(host.querySelector("#ecosystem-detail pre")).toBeNull();
  expect(rpc.mock.calls.filter(([m]) => m === "ecosystem.data")).toHaveLength(
    dataCalls + 1,
  );
});
it("clears selected data when pushed metadata identifies another account", async () => {
  button("record-0").click();
  detail.resolve({
    record: { ...record(), data: { content: "A-only detail" } },
    account: a,
    source: "service",
  });
  await settle();
  state = plugin(b);
  view.changed();
  await settle();
  expect(host.textContent).toContain("Workspace B");
  expect(host.textContent).not.toContain("A-only detail");
  expect(host.querySelector("#ecosystem-detail pre")).toBeNull();
});
it("shows permission denial without optimistic grants then clears both grants on acknowledged read-off", async () => {
  state = { ...state, agentWrite: false };
  await view.open("profile-a", "company-os");
  const pending = deferred<unknown>();
  rpc.mockImplementationOnce(() => pending.promise);
  host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.click();
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.checked,
  ).toBe(false);
  pending.reject(Error("Provider did not grant writes"));
  await settle();
  expect(host.textContent).toContain("Provider did not grant writes");
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.checked,
  ).toBe(false);
  state = { ...state, agentWrite: true };
  await view.open("profile-a", "company-os");
  host.querySelector<HTMLInputElement>("#ecosystem-agent-read")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("ecosystem.permissions", {
    profile: "profile-a",
    pluginId: "company-os",
    agentRead: false,
    agentWrite: false,
  });
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-read")!.checked,
  ).toBe(false);
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.checked,
  ).toBe(false);
});
it("preserves the remote-revocation warning after local disconnect", async () => {
  rpc.mockImplementationOnce(async () => {
    state = {
      ...state,
      status: "disconnected",
      account: undefined,
      agentRead: false,
      agentWrite: false,
    };
    return {
      reason: "Disconnected on this Mac. Remote revocation was not confirmed.",
    };
  });
  button("disconnect").click();
  await settle();
  expect(host.textContent).toContain("Remote revocation was not confirmed");
  expect(host.textContent).not.toContain("Saved index");
  expect(host.querySelector("#ecosystem-agent-write")).toBeNull();
});
it("shows unavailable framework as paused while preserving and allowing removal of saved enablement", async () => {
  view.dispose();
  const framework = new CompanyOsSettingsView(rpc);
  let configuredEnabled = true;
  rpc.mockImplementation(async (method, args) => {
    if (method === "companyos.configure") {
      configuredEnabled = args!.enabled as boolean;
      return {};
    }
    return {
      enabled: false,
      configuredEnabled,
      available: false,
      message: "Bundled framework file is missing.",
      version: "0.6.0",
      revision: "a".repeat(40),
      sha256: "b".repeat(64),
      package: "@mosnin/companyos",
      integrity: "unavailable",
      latest: { state: "not_checked" },
      autoUpdate: false,
      rollbackAvailable: false,
      runtime: "unavailable",
      schedulingEnabled: false,
    };
  });
  framework.mount(host, "profile-a");
  await settle();
  expect(host.textContent).toContain("Company OS is paused");
  expect(host.textContent).toContain("Bundled framework file is missing");
  expect(host.textContent).toContain("Framework instructions are unavailable");
  expect(host.textContent).not.toContain(
    "Framework instructions are available locally",
  );
  expect(
    host.querySelector<HTMLInputElement>("#company-os-enabled")!.checked,
  ).toBe(true);
  host.querySelector<HTMLInputElement>("#company-os-enabled")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("companyos.configure", {
    profile: "profile-a",
    enabled: false,
  });
  expect(
    host.querySelector<HTMLInputElement>("#company-os-enabled")!.checked,
  ).toBe(false);
  expect(host.textContent).toContain("Company OS is paused");
  framework.mount(undefined);
});

it("clears an open record when metadata reports reduced OAuth scopes", async () => {
  await view.open("profile", "company-os");
  button("record-0").click();
  detail.resolve({
    record: { ...record(), data: { instructions: "OLD_PRIVATE_FIELD" } },
    account: a,
    source: "service",
  });
  await settle();
  expect(fields()).toContain("OLD_PRIVATE_FIELD");
  state = { ...state, scopes: ["companyos:data:read"] };
  view.changed();
  await settle();
  expect(host.textContent).not.toContain("OLD_PRIVATE_FIELD");
  expect(host.querySelector("#ecosystem-detail-title")).toBeNull();
});
it("presents escaped readable fields while retaining complete structured data", async () => {
  await view.open("profile", "company-os");
  button("record-0").click();
  detail.resolve({
    record: {
      ...record(),
      data: {
        nextBestAction: "Follow up\nwith the team",
        active: true,
        nested: { html: "<img src=x onerror=alert(1)>" },
      },
    },
    account: a,
    source: "service",
  });
  await settle();
  const reading = host.querySelector('[aria-label="Record content"]')!;
  expect(reading.textContent).toContain("Next Best Action");
  expect(reading.textContent).toContain("Follow up\nwith the team");
  expect(reading.textContent).toContain("Yes");
  expect(reading.querySelector("img")).toBeNull();
  expect(fields()).toContain('"nextBestAction"');
});
