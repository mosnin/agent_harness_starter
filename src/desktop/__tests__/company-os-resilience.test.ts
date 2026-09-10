import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompanyOsService, type CompanyOsRelease } from "../core/company-os";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn());
  vi.mocked(readFileSync).mockClear();
});
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "company-os-resilience-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  function bundle(version = "0.6.0", revision = "0".repeat(40)) {
    const text = "# Company OS\nVerified instructions";
    const data = JSON.stringify({
      schema: 1,
      package: "@mosnin/companyos",
      version,
      revision,
      repository: "https://github.com/mosnin/companyos",
      license: "UNLICENSED",
      distributionSha256: "a".repeat(64),
      files: [
        {
          path: "company-os/company-os/SKILL.md",
          sha256: hash(text),
          bytes: Buffer.byteLength(text),
          text,
        },
      ],
    });
    const path = join(root, version + ".json");
    writeFileSync(path, data);
    return { path, data, release: { version, revision, sha256: hash(data) } };
  }
  const base = bundle(),
    directory = join(root, "state"),
    fetcher = vi.fn();
  function service(path = base.path, release: CompanyOsRelease = base.release) {
    const instance = new CompanyOsService(directory, path, release, fetcher);
    cleanup.push(() => instance.close());
    return instance;
  }
  return { root, directory, base, bundle, service, fetcher };
}
it("starts safely without optional bundled files and refuses enabling", () => {
  const f = fixture();
  unlinkSync(f.base.path);
  const service = f.service();
  expect(service.status("p")).toMatchObject({
    enabled: false,
    configuredEnabled: false,
    available: false,
    integrity: "unavailable",
    runtime: "unavailable",
    rollbackAvailable: false,
  });
  expect(service.setEnabled("p", false).enabled).toBe(false);
  expect(() => service.setEnabled("p", true)).toThrow();
  expect(() => service.setAutoUpdate("p", true)).toThrow();
  expect(() => service.context("p")).toThrow(/unavailable/);
  expect(() => service.catalog("p")).toThrow(/unavailable/);
  expect(service.status("p").configuredEnabled).toBe(false);
  expect(f.fetcher).not.toHaveBeenCalled();
});
it("reports a corrupt bundle as integrity failure without failing construction", () => {
  const f = fixture();
  writeFileSync(f.base.path, "not trusted");
  const service = f.service();
  expect(service.status("p")).toMatchObject({
    available: false,
    integrity: "integrity-error",
    enabled: false,
  });
  expect(service.setEnabled("p", false).enabled).toBe(false);
});
it("keeps a saved preference but disables corrupt active instructions across restart", () => {
  const f = fixture(),
    first = f.service();
  first.setEnabled("p", true);
  first.close();
  writeFileSync(f.base.path, "corrupt");
  const reopened = f.service();
  expect(reopened.status("p")).toMatchObject({
    enabled: false,
    configuredEnabled: true,
    integrity: "integrity-error",
  });
  expect(() => reopened.context("p")).toThrow(/integrity/);
  expect(reopened.setEnabled("p", false)).toMatchObject({
    enabled: false,
    configuredEnabled: false,
  });
});
it("shares stable status verification across profiles but rereads actual context bytes", () => {
  const f = fixture(),
    service = f.service();
  vi.mocked(readFileSync).mockClear();
  service.status("one");
  const cold = vi.mocked(readFileSync).mock.calls.length;
  expect(cold).toBe(1);
  for (let i = 0; i < 8; i++) service.status("profile" + i);
  expect(vi.mocked(readFileSync).mock.calls.length).toBe(cold);
  service.setEnabled("one", true);
  const before = vi.mocked(readFileSync).mock.calls.length;
  expect(service.context("one").content).toContain("Verified instructions");
  expect(vi.mocked(readFileSync).mock.calls.length).toBe(before + 1);
  writeFileSync(
    f.base.path,
    f.base.data.replace("Verified instructions", "Modified instructions"),
  );
  expect(service.status("one").integrity).toBe("integrity-error");
  expect(() => service.context("one")).toThrow(/integrity/);
});
it("starts with a verified retained active release when optional bundled source disappears", () => {
  const f = fixture(),
    service = f.service(),
    next = f.bundle("0.6.1", "1".repeat(40));
  service.activateVerified(next.path, next.release, f.base.release.sha256);
  service.setEnabled("p", true);
  service.close();
  unlinkSync(f.base.path);
  const reopened = f.service();
  expect(reopened.status("p")).toMatchObject({
    available: true,
    enabled: true,
    version: "0.6.1",
    rollbackAvailable: false,
  });
  expect(reopened.context("p").revision).toBe(next.release.revision);
});
it("restores a known verified bundle when active and previous retained bytes are corrupt", () => {
  const f = fixture(),
    service = f.service(),
    second = f.bundle("0.6.1", "1".repeat(40)),
    third = f.bundle("0.6.2", "2".repeat(40));
  service.activateVerified(second.path, second.release, f.base.release.sha256);
  service.activateVerified(third.path, third.release, second.release.sha256);
  writeFileSync(
    join(f.directory, second.release.sha256 + ".json"),
    "corrupt previous",
  );
  writeFileSync(
    join(f.directory, third.release.sha256 + ".json"),
    "corrupt active",
  );
  expect(service.status("p")).toMatchObject({
    available: false,
    rollbackAvailable: true,
  });
  expect(() => service.rollback(second.release.sha256)).toThrow(/changed/);
  expect(service.rollback(third.release.sha256)).toEqual(f.base.release);
  expect(service.status("p")).toMatchObject({
    available: true,
    version: "0.6.0",
    rollbackAvailable: false,
  });
});
it("refuses rollback if the candidate changes after status advertised it", () => {
  const f = fixture(),
    service = f.service(),
    next = f.bundle("0.6.1", "1".repeat(40));
  service.activateVerified(next.path, next.release, f.base.release.sha256);
  expect(service.status("p").rollbackAvailable).toBe(true);
  writeFileSync(f.base.path, "corrupt rollback");
  expect(() => service.rollback(next.release.sha256)).toThrow(/verified/);
  expect(service.status("p")).toMatchObject({
    version: "0.6.1",
    available: true,
    rollbackAvailable: false,
  });
});
it("does not activate corrupt update data to repair a missing bundle", () => {
  const f = fixture();
  unlinkSync(f.base.path);
  const service = f.service(),
    next = f.bundle("0.6.1", "1".repeat(40));
  writeFileSync(next.path, "untrusted");
  expect(() =>
    service.activateVerified(next.path, next.release, f.base.release.sha256),
  ).toThrow(/integrity/);
  expect(service.status("p")).toMatchObject({
    version: "0.6.0",
    available: false,
  });
});

it.each(["duplicate", "missing-root"])(
  "does not advertise an unusable %s distribution as an available update",
  async (kind) => {
    const { gzipSync } = await import("node:zlib");
    const { fetchCompanyOsUpdate } = await import("../core/company-os-updates");
    const path =
      kind === "missing-root"
        ? "company-os/other/SKILL.md"
        : "company-os/company-os/SKILL.md";
    const text = "# Guidance";
    const entry = { path, size: Buffer.byteLength(text), sha256: hash(text) };
    const entries: Record<string, string> = {
      "package/package.json": JSON.stringify({
        name: "@mosnin/companyos",
        version: "0.6.1",
        license: "UNLICENSED",
      }),
      "package/VERSION": "0.6.1",
      "package/distribution-manifest.json": JSON.stringify({
        distribution_version: "0.6.1",
        files: kind === "duplicate" ? [entry, entry] : [entry],
      }),
      ["package/skills/" + path]: text,
    };
    const chunks: Buffer[] = [];
    for (const [name, value] of Object.entries(entries)) {
      const body = Buffer.from(value),
        header = Buffer.alloc(512);
      header.write(name);
      header.write("0000644\0", 100);
      header.write(body.length.toString(8).padStart(11, "0") + "\0", 124);
      header.fill(32, 148, 156);
      header.write("0", 156);
      header.write(
        header
          .reduce((a, b) => a + b, 0)
          .toString(8)
          .padStart(6, "0") + "\0 ",
        148,
      );
      chunks.push(
        header,
        body,
        Buffer.alloc((512 - (body.length % 512)) % 512),
      );
    }
    const archive = gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
    const metadata = {
      name: "@mosnin/companyos",
      "dist-tags": { latest: "0.6.1" },
      versions: {
        "0.6.1": {
          name: "@mosnin/companyos",
          version: "0.6.1",
          gitHead: "1".repeat(40),
          dist: {
            integrity:
              "sha512-" + createHash("sha512").update(archive).digest("base64"),
            tarball:
              "https://registry.npmjs.org/@mosnin/companyos/-/companyos-0.6.1.tgz",
          },
        },
      },
    };
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(url.endsWith(".tgz") ? archive : JSON.stringify(metadata)),
    );
    await expect(
      fetchCompanyOsUpdate("0.6.0", fetcher, new AbortController().signal),
    ).rejects.toThrow(/distribution/);
  },
);
