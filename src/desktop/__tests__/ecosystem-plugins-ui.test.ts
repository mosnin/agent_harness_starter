// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CompanyOsSettingsView,
  EcosystemPluginsView,
  ecosystemPlugins,
  type PluginView,
  type PluginData,
} from "../ui/ecosystem-plugins";

const account = { id: "account-1", name: "My team", tenantId: "tenant-1" };
const connected = (id: PluginView["id"] = "stored"): PluginView => ({
  id,
  name: id,
  origin: "https://accounts.example.test",
  description: "Connected workspace data",
  status: "connected",
  account,
  collections: ["notes", "files"],
  lastSyncedAt: 1_700_000_000_000,
  agentRead: true,
  agentWrite: false,
  scopes: ["notes:read"],
  syncMode: "polling",
});
const page = (overrides: Partial<PluginData> = {}): PluginData => ({
  records: [
    {
      id: "note-1",
      collection: "notes",
      title: "Project notes",
      revision: "r1",
      data: { text: "Private content" },
    },
  ],
  total: 1,
  collections: ["notes", "files"],
  status: "connected",
  lastSyncedAt: 1_700_000_000_000,
  account,
  ...overrides,
});
const settle = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
let host: HTMLElement, view: EcosystemPluginsView;
let rpc = vi.fn<(method: string, args?: any) => Promise<any>>();
let unlock = vi.fn<() => Promise<unknown>>(),
  openUrl = vi.fn<(url: string) => Promise<unknown>>();
let plugin: PluginView;
const click = (action: string) =>
  host.querySelector<HTMLButtonElement>(`#ecosystem-${action}`)!.click();
beforeEach(async () => {
  document.body.innerHTML = "<main></main>";
  host = document.querySelector("main")!;
  plugin = connected();
  rpc = vi.fn(async (method: string, args?: any) => {
    if (method === "ecosystem.list") return [structuredClone(plugin)];
    if (method === "ecosystem.data") return page();
    if (method === "ecosystem.permissions") {
      plugin = {
        ...plugin,
        agentRead: args.agentRead,
        agentWrite: args.agentWrite,
      };
      return plugin;
    }
    if (method === "ecosystem.disconnect") {
      plugin = {
        ...plugin,
        status: "disconnected",
        account: undefined,
        agentRead: false,
        agentWrite: false,
      };
      return true;
    }
    if (method === "ecosystem.connect") {
      plugin = { ...plugin, status: "connecting" };
      return {
        authorizationUrl:
          "https://accounts.example.test/authorize?state=opaque",
        requestId: "request",
      };
    }
    return true;
  });
  unlock = vi.fn(async () => true);
  openUrl = vi.fn(async () => true);
  view = new EcosystemPluginsView(rpc, openUrl, unlock);
  view.mount(host);
  await view.open("profile-a", "stored");
});
afterEach(() => {
  view.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});

it("uses the seven real catalogue routes, shows account grants and truthful freshness", () => {
  expect(ecosystemPlugins.map((plugin) => plugin.name)).toEqual([
    "Stored",
    "Operate",
    "Scalar",
    "Company OS",
    "Cadre",
    "Glove",
    "Govern",
  ]);
  expect(host.textContent).toContain("My team");
  expect(host.textContent).toContain("Periodic snapshots");
  expect(host.textContent).toContain("notes:read");
  expect(host.textContent).toContain("they cannot add permissions");
  expect(host.querySelector("iframe")).toBeNull();
  expect(rpc).toHaveBeenCalledWith("ecosystem.data", {
    profile: "profile-a",
    pluginId: "stored",
    offset: 0,
  });
});

it("labels live updates only when the service reports an active live subscription", async () => {
  expect(host.textContent).not.toContain("Live updates");
  plugin = { ...plugin, syncMode: "live" };
  await view.open("profile-a", "stored");
  expect(host.textContent).toContain("Live updates");
  expect(host.textContent).not.toContain("Periodic snapshots");
});

it("uses only server pagination offsets and resets the page for collection and search", async () => {
  rpc.mockImplementationOnce(async () => page({ total: 15, nextOffset: 7 }));
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  click("next");
  await settle();
  expect(rpc).toHaveBeenLastCalledWith("ecosystem.data", {
    profile: "profile-a",
    pluginId: "stored",
    offset: 7,
  });
  expect(
    host.querySelector<HTMLButtonElement>("#ecosystem-next")!.disabled,
  ).toBe(true);
  click("previous");
  await settle();
  expect(rpc.mock.calls.at(-1)?.[1].offset).toBe(0);
  const collection = host.querySelector<HTMLSelectElement>(
    "#ecosystem-collection",
  )!;
  collection.value = "notes";
  collection.dispatchEvent(new Event("change"));
  await settle();
  const query = host.querySelector<HTMLInputElement>("#ecosystem-query")!;
  query.value = "roadmap";
  query.dispatchEvent(new Event("input"));
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  expect(rpc).toHaveBeenLastCalledWith("ecosystem.data", {
    profile: "profile-a",
    pluginId: "stored",
    collection: "notes",
    query: "roadmap",
    offset: 0,
  });
});

it("bounds and escapes record detail fields, then returns keyboard focus to the record", async () => {
  rpc.mockImplementationOnce(async () =>
    page({
      records: [
        {
          id: "unsafe",
          title: "<img src=x onerror=bad>",
          collection: "notes",
          data: { html: "<script>bad</script>" + "x".repeat(40_000) },
        },
      ],
    }),
  );
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  host.querySelector<HTMLButtonElement>("#ecosystem-record-0")!.click();
  expect(host.querySelector("#ecosystem-detail pre")!.textContent!.length).toBe(
    32_000,
  );
  expect(host.querySelector("img, script")).toBeNull();
  expect(document.activeElement?.id).toBe("ecosystem-detail-title");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }),
  );
  expect(document.activeElement?.id).toBe("ecosystem-record-0");
  expect(host.querySelector("#ecosystem-detail pre")).toBeNull();
});

it("does not expand provider scopes or report failed agent grants as enabled", async () => {
  const pending = deferred<unknown>();
  rpc.mockImplementationOnce(() => pending.promise);
  host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.click();
  expect(rpc).toHaveBeenLastCalledWith("ecosystem.permissions", {
    profile: "profile-a",
    pluginId: "stored",
    agentRead: true,
    agentWrite: true,
  });
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.checked,
  ).toBe(false);
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.disabled,
  ).toBe(true);
  pending.reject(Error("Write scope was not granted"));
  await settle();
  expect(
    host.querySelector<HTMLInputElement>("#ecosystem-agent-write")!.checked,
  ).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    "Write scope was not granted",
  );
});

it("unlocks natively before connecting and opens only the returned authorization URL", async () => {
  const pending = deferred<boolean>();
  unlock.mockImplementationOnce(() => pending.promise);
  const count = rpc.mock.calls.length;
  click("connect");
  click("connect");
  await settle();
  expect(unlock).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls).toHaveLength(count);
  pending.resolve(true);
  await settle();
  expect(rpc).toHaveBeenCalledWith("ecosystem.connect", {
    profile: "profile-a",
    pluginId: "stored",
    access: "read",
  });
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(
    "https://accounts.example.test/authorize?state=opaque",
  );
  expect(host.textContent).toContain("Awaiting sign-in");
  expect(host.textContent).not.toContain("opaque");
});

it("withdraws a pending connection when navigating away and rejects unsafe authorization URLs", async () => {
  const pending = deferred<boolean>();
  unlock.mockImplementationOnce(() => pending.promise);
  click("connect");
  view.mount(undefined);
  pending.resolve(true);
  await settle();
  expect(rpc.mock.calls.some((call) => call[0] === "ecosystem.connect")).toBe(
    false,
  );
  view.mount(host);
  await view.open("profile-a", "stored");
  rpc.mockImplementationOnce(async () => ({
    authorizationUrl: "javascript:bad()",
    requestId: "bad",
  }));
  click("connect");
  await settle();
  expect(openUrl).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
});

it("keeps disconnect reachable during an in-flight connect and ignores its late result", async () => {
  const pending = deferred<unknown>();
  rpc.mockImplementationOnce(() => pending.promise);
  click("connect");
  await settle();
  click("disconnect");
  await settle();
  expect(rpc).toHaveBeenCalledWith("ecosystem.disconnect", {
    profile: "profile-a",
    pluginId: "stored",
  });
  pending.resolve({
    authorizationUrl: "https://accounts.example.test/old",
    requestId: "old",
  });
  await settle();
  expect(openUrl).not.toHaveBeenCalled();
  expect(host.textContent).toContain("Not connected");
  expect(host.textContent).not.toContain("Private content");
});

it("never displays late data from a previous profile or an account that changed during loading", async () => {
  const pending = deferred<PluginData>();
  rpc.mockImplementationOnce(() => pending.promise);
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  plugin = {
    ...connected("govern"),
    account: { ...account, id: "account-2", name: "Second team" },
  };
  rpc.mockImplementation(async (method) =>
    method === "ecosystem.list"
      ? [plugin]
      : page({ account: plugin.account, records: [] }),
  );
  await view.open("profile-b", "govern");
  pending.resolve(page());
  await settle();
  expect(host.textContent).toContain("Second team");
  expect(host.textContent).not.toContain("Project notes");
  rpc.mockImplementationOnce(async () => page());
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  expect(host.textContent).toContain("connected account changed");
  expect(host.textContent).not.toContain("Project notes");
});

it("shows reasoned unavailable connections without fake data or an enabled Connect action", async () => {
  plugin = {
    ...connected("cadre"),
    account: undefined,
    status: "unavailable",
    reason:
      "Account authorization is available; a scoped data adapter is not yet available.",
    syncMode: "unavailable",
  };
  const before = rpc.mock.calls.filter(
    (call) => call[0] === "ecosystem.data",
  ).length;
  await view.open("profile-a", "cadre");
  expect(host.textContent).toContain("scoped data adapter");
  expect(host.querySelector("#ecosystem-connect")).toBeNull();
  expect(host.querySelector("#ecosystem-query")).toBeNull();
  expect(
    rpc.mock.calls.filter((call) => call[0] === "ecosystem.data"),
  ).toHaveLength(before);
});

it("limits malformed pages and never invents an offset for clipped or non-forward responses", async () => {
  rpc.mockImplementationOnce(async () =>
    page({
      records: Array.from({ length: 101 }, (_, i) => ({
        id: String(i),
        collection: "notes",
        title: String(i),
        data: {},
      })),
      total: 101,
      nextOffset: 101,
    }),
  );
  host
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { cancelable: true }));
  await settle();
  expect(host.querySelectorAll("[data-ecosystem-record]")).toHaveLength(100);
  expect(host.textContent).toContain("exceeded the page limit");
  expect(
    host.querySelector<HTMLButtonElement>("#ecosystem-next")!.disabled,
  ).toBe(true);
});

it("checks pending connections for one bounded minute and stops polling while unmounted", async () => {
  vi.useFakeTimers();
  plugin = { ...connected(), account: undefined, status: "connecting" };
  await view.open("profile-a", "stored");
  const count = rpc.mock.calls.length;
  await vi.advanceTimersByTimeAsync(65_000);
  expect(rpc.mock.calls.length - count).toBe(12);
  await view.open("profile-a", "stored");
  view.mount(undefined);
  const closed = rpc.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(rpc.mock.calls).toHaveLength(closed);
});

it("renders framework version and controls with profile-scoped configuration and digest-fenced rollback", async () => {
  view.dispose();
  const status = {
    enabled: false,
    autoUpdate: false,
    version: "1.2.3",
    revision: "a".repeat(40),
    sha256: "b".repeat(64),
    integrity: "verified",
    package: "@mosnin/companyos",
    runtime: "instructions-only",
    schedulingEnabled: false,
    rollbackAvailable: true,
    latest: { state: "available", version: "1.2.4" },
  };
  rpc.mockImplementation(async (method, args) => {
    if (method === "companyos.configure") Object.assign(status, args);
    return status;
  });
  const settings = new CompanyOsSettingsView(rpc);
  settings.mount(host, "profile-a");
  await settle();
  expect(host.textContent).toContain("Version 1.2.3");
  expect(host.textContent).toContain("scheduling is off");
  const checksBefore = rpc.mock.calls.filter(
    (call) => call[0] === "companyos.check",
  ).length;
  host.querySelector<HTMLButtonElement>("#company-os-refresh")!.click();
  await settle();
  expect(rpc).toHaveBeenLastCalledWith("companyos.status", {
    profile: "profile-a",
  });
  expect(
    rpc.mock.calls.filter((call) => call[0] === "companyos.check"),
  ).toHaveLength(checksBefore);
  host.querySelector<HTMLInputElement>("#company-os-enabled")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("companyos.configure", {
    profile: "profile-a",
    enabled: true,
  });
  host.querySelector<HTMLInputElement>("#company-os-auto-update")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("companyos.configure", {
    profile: "profile-a",
    autoUpdate: true,
  });
  expect(host.querySelector("#company-os-check")?.textContent).toBe(
    "Check and update",
  );
  host.querySelector<HTMLButtonElement>("#company-os-apply")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("companyos.check", {
    profile: "profile-a",
    apply: true,
  });
  host.querySelector<HTMLButtonElement>("#company-os-rollback")!.click();
  await settle();
  expect(rpc).toHaveBeenCalledWith("companyos.rollback", {
    profile: "profile-a",
    expectedActiveSha: "b".repeat(64),
  });
  settings.mount(undefined);
});

it("does not carry framework settings acknowledgements into a different profile", async () => {
  view.dispose();
  const status = {
    enabled: false,
    autoUpdate: false,
    version: "1.2.3",
    revision: "a",
    sha256: "b",
    integrity: "verified",
    latest: { state: "not_checked" },
  };
  rpc.mockImplementation(async () => status);
  const settings = new CompanyOsSettingsView(rpc);
  settings.mount(host, "profile-a");
  await settle();
  const pending = deferred<unknown>();
  rpc.mockImplementationOnce(() => pending.promise);
  host.querySelector<HTMLInputElement>("#company-os-enabled")!.click();
  settings.mount(host, "profile-b");
  await settle();
  pending.reject(Error("Old profile denied"));
  await settle();
  expect(host.textContent).not.toContain("Old profile denied");
  expect(
    host.querySelector<HTMLInputElement>("#company-os-enabled")!.checked,
  ).toBe(false);
  settings.mount(undefined);
});
