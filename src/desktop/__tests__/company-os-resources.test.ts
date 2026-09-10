import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CompanyOsService } from "../core/company-os";
import { companyOsTools } from "../core/company-os-tools";

const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const actualPath = resolve("third_party/company-os/bundle.json");
const actualRelease = JSON.parse(
  readFileSync("third_party/company-os/manifest.json", "utf8"),
);
const actualBundle = JSON.parse(readFileSync(actualPath, "utf8")) as {
  files: Array<{ path: string; text: string; bytes: number; sha256: string }>;
};
const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach((fn) => fn()));
function fixture(actual = false) {
  const directory = mkdtempSync(join(tmpdir(), "company-os-resources-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const unicode = "a".repeat(511) + "🙂é世界".repeat(400) + "\nend";
  const entries = {
    "company-os/company-os/SKILL.md": "# Company OS\nLocal fixture guidance.",
    "company-os/example/SKILL.md": "Read [reference](references/unicode.md).",
    "company-os/example/references/unicode.md": unicode,
    "company-os/example/references/empty.md": "",
    "company-os/example/scripts/example.py": "raise RuntimeError('TEXT ONLY')\n",
    "autonomy-suite/example/SKILL.md": "# Another framework skill",
  };
  const bundle = {
    schema: 1,
    package: "@mosnin/companyos",
    version: "0.6.0",
    revision: "0".repeat(40),
    repository: "https://github.com/mosnin/companyos",
    license: "UNLICENSED",
    distributionSha256: "a".repeat(64),
    files: Object.entries(entries).map(([path, text]) => ({
      path, text, bytes: Buffer.byteLength(text), sha256: digest(text),
    })),
  };
  const raw = JSON.stringify(bundle), path = join(directory, "bundle.json");
  if (!actual) writeFileSync(path, raw);
  const release = actual ? actualRelease : {
    version: bundle.version, revision: bundle.revision, sha256: digest(raw),
  };
  const fetcher = vi.fn(async () => { throw Error("Network forbidden in fixture"); });
  const service = new CompanyOsService(
    join(directory, "state"), actual ? actualPath : path, release, fetcher,
  );
  cleanup.push(() => service.close());
  service.setEnabled("owner", true);
  const controller = new AbortController();
  const tool = companyOsTools(service, "owner", controller.signal)[0];
  async function read(input: unknown) {
    const result = await tool.run(JSON.stringify(input));
    expect(result.ok, result.output).toBe(true);
    return JSON.parse(result.output);
  }
  return { directory, path, bundle, release, service, fetcher, controller, tool, read, unicode };
}
function changeCursor(cursor: string, change: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({
    ...JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")), ...change,
  })).toString("base64url");
}

it("loads the actual complete Emil skill through the existing skill input", async () => {
  const f = fixture(true), path = "company-os/ui-design-quality/vendor/emil-design-eng/SKILL.md";
  const source = actualBundle.files.find((file) => file.path === path)!;
  expect(source.bytes).toBeGreaterThan(24000);
  expect(() => f.service.context("owner", { skill: path })).toThrow(/budget/);
  const result = await f.read({ skill: path });
  expect(result.content).toBe(source.text);
  expect(Buffer.byteLength(result.content)).toBe(source.bytes);
  expect(result.sha256).toBe(actualRelease.sha256);
  expect(result.complete).toBe(true);
  const skills = await f.read({});
  expect(skills).toContainEqual({ path, bytes: source.bytes });
  expect(f.fetcher).not.toHaveBeenCalled();
});

it("discovers all actual resources through bounded deterministic pages", async () => {
  const f = fixture(true), paths: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await f.read({ resources: true, limit: 37, ...(cursor ? { cursor } : {}) });
    expect(page.entries.length).toBeLessThanOrEqual(37);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
    expect(page).toMatchObject({ total: actualBundle.files.length, sha256: actualRelease.sha256 });
    expect(page.offset).toBe(paths.length);
    for (const item of page.entries) {
      const source = actualBundle.files.find((file) => file.path === item.path)!;
      expect(item).toMatchObject({ bytes: source.bytes, fileSha256: source.sha256 });
      expect(item.directory).toBe(item.path.slice(0, item.path.lastIndexOf("/")));
      paths.push(item.path);
    }
    expect(page.nextOffset).toBe(page.complete ? null : paths.length);
    cursor = page.nextCursor;
    expect(!!cursor).toBe(!page.complete);
  } while (cursor);
  expect(paths).toEqual(actualBundle.files.map((file) => file.path).sort());
  expect(new Set(paths).size).toBe(actualBundle.files.length);
});

it("reconstructs the actual 2MB capability catalog with exact hash-bound text chunks", async () => {
  const f = fixture(true), from = "company-os/assign-capability-skills/SKILL.md";
  const path = "company-os/assign-capability-skills/references/capability-catalog.json";
  const source = actualBundle.files.find((file) => file.path === path)!;
  expect(source.bytes).toBeGreaterThan(2_000_000);
  let cursor: string | undefined, content = "", consumed = 0, pages = 0;
  do {
    const page = await f.read({
      resource: "references/capability-catalog.json", from, maxBytes: 32768,
      ...(cursor ? { cursor } : {}),
    });
    expect(page).toMatchObject({
      path, version: actualRelease.version, revision: actualRelease.revision,
      sha256: actualRelease.sha256, fileSha256: source.sha256,
      offset: consumed, totalBytes: source.bytes, interpretation: "data",
    });
    expect(page.bytes).toBe(Buffer.byteLength(page.content));
    expect(page.bytes).toBeGreaterThan(0);
    expect(page.bytes).toBeLessThanOrEqual(32768);
    expect(page.chunkSha256).toBe(digest(page.content));
    consumed += page.bytes; content += page.content; pages++;
    expect(page.nextOffset).toBe(page.complete ? null : consumed);
    expect(page.complete).toBe(consumed === source.bytes);
    expect(page.authority).toMatch(/No framework scripts/);
    cursor = page.nextCursor;
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
  expect(content).toBe(source.text);
  expect(digest(content)).toBe(source.sha256);
  expect(JSON.parse(content)).toEqual(JSON.parse(source.text));
  expect(f.fetcher).not.toHaveBeenCalled();
}, 15000);

it("keeps UTF-8 boundaries exact and returns empty and script resources as data", async () => {
  const f = fixture(), resource = "company-os/example/references/unicode.md";
  let cursor: string | undefined, content = "";
  do {
    const page = await f.read({ resource, maxBytes: 512, ...(cursor ? { cursor } : {}) });
    expect(page.content).not.toContain("\uFFFD");
    expect(page.bytes).toBeGreaterThan(0);
    content += page.content; cursor = page.nextCursor;
  } while (cursor);
  expect(content).toBe(f.unicode);
  const empty = await f.read({ resource: "references/empty.md", from: "company-os/example/SKILL.md" });
  expect(empty).toMatchObject({ content: "", bytes: 0, totalBytes: 0, offset: 0, nextOffset: null, complete: true });
  expect(empty.nextCursor).toBeUndefined();
  const script = await f.read({ resource: "company-os/example/scripts/example.py" });
  expect(script).toMatchObject({ content: "raise RuntimeError('TEXT ONLY')\n", complete: true, interpretation: "data" });
});

it("resolves parent-relative references only into the verified inventory", async () => {
  const f = fixture(), from = "company-os/example/SKILL.md";
  expect(await f.read({ resource: "../../autonomy-suite/example/SKILL.md", from }))
    .toMatchObject({ path: "autonomy-suite/example/SKILL.md", content: "# Another framework skill", complete: true });
  for (const input of [
    { resource: "../../../etc/passwd", from },
    { resource: "/etc/passwd", from },
    { resource: "file:///etc/passwd", from },
    { resource: "references/unicode.md", from: "company-os/example/missing.md" },
    { resource: "references/unicode.md", from: "/etc/passwd" },
  ]) expect((await f.tool.run(JSON.stringify(input))).ok).toBe(false);
});

it("never silently truncates an oversized skill but permits explicit incomplete data pages", async () => {
  const f = fixture(), path = "company-os/large/SKILL.md", text = "x".repeat(64001);
  const next = { ...f.bundle, version: "0.6.1", revision: "1".repeat(40), files: [
    ...f.bundle.files, { path, text, bytes: Buffer.byteLength(text), sha256: digest(text) },
  ] };
  const raw = JSON.stringify(next), candidate = join(f.directory, "large.json");
  writeFileSync(candidate, raw);
  f.service.activateVerified(candidate, { version: next.version, revision: next.revision, sha256: digest(raw) }, f.release.sha256);
  expect(await f.tool.run(JSON.stringify({ skill: path })))
    .toMatchObject({ ok: false, output: expect.stringMatching(/budget/) });
  expect(await f.read({ resource: path }))
    .toMatchObject({ complete: false, totalBytes: 64001, bytes: 16000, nextOffset: 16000, interpretation: "data" });
});

it("binds resource continuation to current profile, release, path, hash and UTF-8 offset", async () => {
  const f = fixture(), resource = "company-os/example/references/unicode.md";
  const first = await f.read({ resource, maxBytes: 512 });
  expect(first.nextCursor).toBeTypeOf("string");
  for (const change of [
    { profile: "other" }, { sha256: "1".repeat(64) },
    { path: "company-os/example/scripts/example.py" }, { fileSha256: "2".repeat(64) },
    { fileSha256: undefined }, { offset: -1 }, { offset: 512 }, { offset: 1e20 },
  ]) {
    const result = await f.tool.run(JSON.stringify({ resource, cursor: changeCursor(first.nextCursor, change) }));
    expect(result.ok, JSON.stringify(change)).toBe(false);
  }
  f.service.setEnabled("other", true);
  const otherTool = companyOsTools(f.service, "other", new AbortController().signal)[0];
  expect((await otherTool.run(JSON.stringify({ resource, cursor: first.nextCursor }))).ok).toBe(false);
  expect((await f.tool.run(JSON.stringify({ resource: "company-os/example/scripts/example.py", cursor: first.nextCursor }))).ok).toBe(false);
});

it("binds discovery continuation to prefix, profile, release and operation", async () => {
  const f = fixture();
  const page = await f.read({ resources: true, prefix: "company-os/example/", limit: 1 });
  expect(page.total).toBe(4);
  for (const change of [{ profile: "other" }, { sha256: "3".repeat(64) }, { prefix: "autonomy-suite/" }, { type: "resource" }, { offset: -1 }]) {
    expect((await f.tool.run(JSON.stringify({ resources: true, prefix: "company-os/example/", cursor: changeCursor(page.nextCursor, change) }))).ok).toBe(false);
  }
  expect((await f.tool.run(JSON.stringify({ resources: true, cursor: page.nextCursor }))).ok).toBe(false);
});

it("refuses continuation after verified activation rather than mixing revisions", async () => {
  const f = fixture(), resource = "company-os/example/references/unicode.md";
  const first = await f.read({ resource, maxBytes: 512 });
  const listing = await f.read({ resources: true, limit: 1 });
  const next = { ...f.bundle, version: "0.6.1", revision: "1".repeat(40) };
  const raw = JSON.stringify(next), path = join(f.directory, "next.json");
  writeFileSync(path, raw);
  f.service.activateVerified(path, { version: next.version, revision: next.revision, sha256: digest(raw) }, f.release.sha256);
  expect((await f.tool.run(JSON.stringify({ resource, cursor: first.nextCursor }))).ok).toBe(false);
  expect((await f.tool.run(JSON.stringify({ resources: true, cursor: listing.nextCursor }))).ok).toBe(false);
  expect((await f.read({ resource })).version).toBe("0.6.1");
});

it("refuses changed bundle bytes after the first verified page", async () => {
  const f = fixture(), resource = "company-os/example/references/unicode.md";
  const first = await f.read({ resource, maxBytes: 512 });
  writeFileSync(f.path, readFileSync(f.path, "utf8") + " ");
  expect((await f.tool.run(JSON.stringify({ resource, cursor: first.nextCursor }))).ok).toBe(false);
  expect((await f.tool.run(JSON.stringify({ resources: true }))).ok).toBe(false);
});

it("rechecks disabled state on retained tools for every input form", async () => {
  const f = fixture(), first = await f.read({ resource: "company-os/example/references/unicode.md", maxBytes: 512 });
  f.service.setEnabled("owner", false);
  expect(companyOsTools(f.service, "owner", f.controller.signal)).toEqual([]);
  for (const input of [{}, { skill: "company-os/example/SKILL.md" }, { resources: true }, { resource: "company-os/example/references/unicode.md", cursor: first.nextCursor }]) {
    expect(await f.tool.run(JSON.stringify(input))).toMatchObject({ ok: false, output: expect.stringMatching(/disabled/) });
  }
  expect(() => f.service.resourceCatalog("owner")).toThrow(/disabled/);
  expect(() => f.service.readResource("owner", { resource: "company-os/example/SKILL.md" })).toThrow(/disabled/);
  expect(() => companyOsTools(f.service, undefined as unknown as string, f.controller.signal)).toThrow(/profile/);
});

it("validates malformed JSON and unsupported options even without a separate validation call", async () => {
  const f = fixture();
  for (const input of ["{", "", "null", "{\"resources\":true,\"profile\":\"other\"}", JSON.stringify({ resource: "x", from: null })]) {
    expect(f.tool.validate?.(input)).toBeTypeOf("string");
    expect((await f.tool.run(input)).ok).toBe(false);
  }
});

it("honors cancellation before and after resource reads without exposing a late payload", async () => {
  const f = fixture(), input = { resource: "company-os/example/references/unicode.md" };
  const original = f.service.readResource.bind(f.service);
  vi.spyOn(f.service, "readResource").mockImplementation((...args) => {
    const page = original(...args); f.controller.abort(); return page;
  });
  expect((await f.tool.run(JSON.stringify(input))).ok).toBe(false);
  for (const request of [{}, { skill: "company-os/example/SKILL.md" }, { resources: true }, input])
    expect((await f.tool.run(JSON.stringify(request))).ok).toBe(false);
});

it.each([
  null, [], { profile: "other" }, { resources: false }, { skill: "x", resources: true },
  { resource: "x", skill: "x" }, { resources: true, limit: 0 }, { resources: true, limit: 101 },
  { resource: "x", maxBytes: 511 }, { resource: "x", maxBytes: 32769 },
  { resource: "x", offset: 1 }, { resource: "x", cursor: "" }, { resources: true, cursor: {} },
])("rejects malformed input %j in validation and execution", async (input) => {
  const f = fixture(), raw = JSON.stringify(input);
  expect(f.tool.validate?.(raw)).toBeTypeOf("string");
  expect((await f.tool.run(raw)).ok).toBe(false);
});

it.each(["/etc/passwd", "../../secret", "file:///etc/passwd", "company-os/example/../SKILL.md", "company-os\\example\\SKILL.md", "company-os/example/missing.json"])(
  "refuses non-retained or unsafe resource %s", async (resource) => {
    const f = fixture();
    expect((await f.tool.run(JSON.stringify({ resource }))).ok).toBe(false);
  },
);
