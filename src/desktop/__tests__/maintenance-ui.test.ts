// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { MaintenanceView } from "../ui/maintenance";
let host: HTMLElement, view: MaintenanceView;
let rpc = vi.fn<(method: string, args?: any) => Promise<any>>();
let folder = vi.fn<() => Promise<string | undefined>>();
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const click = (action: string) => host.querySelector<HTMLButtonElement>(`[data-maintenance="${action}"]`)!.click();
const fill = (value: string) => { const input = host.querySelector<HTMLInputElement>('[name="backupPath"]')!; input.value = value; input.dispatchEvent(new Event("input")); };
beforeEach(async () => {
  document.body.innerHTML = "<main></main>"; host = document.querySelector("main")!;
  folder = vi.fn(async () => "/chosen");
  rpc = vi.fn(async (method, args) => {
    if (method === "maintenance.diagnostics") return { os: "darwin", node: "v22", disk: { freeBytes: 1024 }, runtime: [{ name: "node", exists: true }], schemas: [] };
    if (method === "maintenance.list") return [{ path: "/backups/one.json", files: 2, bytes: 1024, createdAt: "2026-09-07T00:00:00Z", exists: true }];
    if (method === "maintenance.verify") return { path: args.path, valid: true, sha256: "verified-digest", totalBytes: 1024, files: [{ path: "sessions.json", bytes: 1024 }], scope: "Integrity, not author identity" };
    if (method === "maintenance.stage") return { path: "/chosen/Hades-import-new", activated: false };
    return { path: "/chosen/result.json" };
  });
  view = new MaintenanceView(rpc, folder); await view.open(); view.mount(host);
});
it("requires a chosen destination and explains private backup scope", async () => {
  expect(host.textContent).toContain("private conversations"); expect(host.textContent).toContain("Provider credentials");
  click("create"); await settle(); expect(folder).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith("maintenance.create", { destination: "/chosen" });
  expect(host.textContent).toContain("Private backup saved");
});
it("pins verified file identity for isolated staging and invalidates review when input changes", async () => {
  expect(host.querySelector<HTMLButtonElement>('[data-maintenance="stage"]')!.disabled).toBe(true);
  click("select"); await settle();
  expect(rpc).toHaveBeenCalledWith("maintenance.verify", { path: "/backups/one.json" });
  click("stage"); await settle();
  expect(rpc).toHaveBeenCalledWith("maintenance.stage", { path: "/backups/one.json", destination: "/chosen", expectedSha256: "verified-digest" });
  expect(host.textContent).toContain("current Hades data remains unchanged");
  fill("/backups/other.json"); expect(host.querySelector<HTMLButtonElement>('[data-maintenance="stage"]')!.disabled).toBe(true);
});
it("does nothing when native folder selection is cancelled", async () => {
  folder.mockResolvedValue(undefined); click("support"); await settle();
  expect(rpc.mock.calls.some(([method]) => method === "maintenance.support")).toBe(false);
});
it("surfaces verification errors without enabling import", async () => {
  rpc.mockImplementation(async method => { if (method === "maintenance.verify") throw new Error("Backup checksum mismatch <img src=x>"); return {}; });
  fill("/bad.json"); click("verify"); await settle();
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("Backup checksum mismatch");
  expect(host.querySelector("img")).toBeNull(); expect(host.querySelector<HTMLButtonElement>('[data-maintenance="stage"]')!.disabled).toBe(true);
});
it("preserves keyboard focus and literal path editing across refresh and async actions", async () => {
  const input = host.querySelector<HTMLInputElement>('[name="backupPath"]')!;
  fill('/backups/literal--path.json'); input.focus(); input.setSelectionRange(9, 16);
  await view.refresh();
  expect(document.activeElement?.id).toBe("maintenance-backup-path");
  expect(host.querySelector<HTMLInputElement>('[name="backupPath"]')!.selectionStart).toBe(9);
  expect(host.querySelector('[name="backupPath"]')?.getAttribute("autocorrect")).toBe("off");
  const verify = host.querySelector<HTMLButtonElement>('[data-maintenance="verify"]')!;
  verify.focus(); click("verify"); await settle();
  expect(document.activeElement?.id).toBe(verify.id);
  expect(host.querySelector<HTMLButtonElement>('[data-maintenance="stage"]')!.disabled).toBe(false);
  const included = host.querySelector<HTMLDetailsElement>("#maintenance-included")!;
  included.open = true; await view.refresh();
  expect(host.querySelector<HTMLDetailsElement>("#maintenance-included")!.open).toBe(true);
});
it("does not steal focus from an outside control when an operation finishes", async () => {
  let finish!: (value: any) => void;
  rpc.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fill('/backup.json');
  host.querySelector<HTMLButtonElement>('[data-maintenance="verify"]')!.focus(); click("verify");
  const outside = document.createElement("button"); document.body.append(outside); outside.focus();
  finish({ path: '/backup.json', totalBytes: 1, files: [], scope: 'integrity' }); await settle();
  expect(document.activeElement).toBe(outside);
});
