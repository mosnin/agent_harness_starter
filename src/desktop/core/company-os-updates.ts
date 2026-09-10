import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
export const COMPANY_OS_REGISTRY =
  "https://registry.npmjs.org/@mosnin%2fcompanyos";
export type CompanyOsFetch = (
  url: string,
  options: { signal: AbortSignal; redirect: "error" },
) => Promise<Response>;
const hash = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
async function body(response: Response, max: number, signal: AbortSignal) {
  if (!response.ok || !response.body) throw Error("Release download failed");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > max) throw Error("Release download exceeds size limit");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
/** Minimal strict npm tar reader. Unsupported links/PAX/long-name formats fail
 * closed rather than extracting arbitrary files. Nothing touches the filesystem. */
export function companyOsTar(gzip: Buffer) {
  const data = gunzipSync(gzip, { maxOutputLength: 32 * 1024 * 1024 }),
    files = new Map<string, Buffer>();
  let offset = 0,
    count = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    if (++count > 4000) throw Error("Archive entry limit");
    const text = (a: number, b: number) =>
      header.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const number = (a: number, b: number) => {
      const value = text(a, b).trim();
      if (!/^[0-7]+$/.test(value)) throw Error("Invalid tar number");
      return parseInt(value, 8);
    };
    const expected = number(148, 156);
    let checksum = 0;
    for (let i = 0; i < 512; i++)
      checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) throw Error("Archive header checksum mismatch");
    const name = [text(345, 500), text(0, 100)].filter(Boolean).join("/");
    const size = number(124, 136),
      kind = text(156, 157);
    if (
      !name.startsWith("package/") ||
      name.split("/").some((p) => p === "." || p === "..") ||
      name.includes("\\") ||
      size > 8 * 1024 * 1024 ||
      offset + 512 + size > data.length
    )
      throw Error("Unsafe archive entry");
    if (kind !== "0" && kind !== "" && kind !== "5")
      throw Error("Unsupported archive link or extension");
    if (kind !== "5") {
      if (files.has(name)) throw Error("Duplicate archive path");
      files.set(name, data.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
export async function fetchCompanyOsUpdate(
  currentVersion: string,
  fetcher: CompanyOsFetch,
  signal: AbortSignal,
) {
  const metadata = JSON.parse(
    (
      await body(
        await fetcher(COMPANY_OS_REGISTRY, { signal, redirect: "error" }),
        2 * 1024 * 1024,
        signal,
      )
    ).toString("utf8"),
  );
  const latest = metadata["dist-tags"]?.latest;
  if (!/^\d+\.\d+\.\d+$/.test(latest) || metadata.name !== "@mosnin/companyos")
    throw Error("Invalid registry release identity");
  const parts = (v: string) => {
      const tuple = v.split(".").map(Number);
      if (
        tuple.length !== 3 ||
        tuple.some((n) => !Number.isSafeInteger(n) || n < 0)
      )
        throw Error("Invalid semantic version");
      return tuple;
    },
    now = parts(currentVersion),
    next = parts(latest);
  if (next[0] !== now[0])
    return { state: "incompatible" as const, version: latest };
  const comparison =
    next.map((n, i) => Math.sign(n - now[i])).find((n) => n !== 0) ?? 0;
  if (comparison <= 0)
    return { state: "current" as const, version: currentVersion };
  const release = metadata.versions?.[latest];
  if (
    release?.name !== "@mosnin/companyos" ||
    release.version !== latest ||
    !/^[a-f0-9]{40}$/.test(release.gitHead) ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(release.dist?.integrity)
  )
    throw Error("Registry release lacks verified identity");
  const url = new URL(release.dist.tarball);
  if (
    url.origin !== "https://registry.npmjs.org" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/@mosnin/companyos/-/companyos-${latest}.tgz`
  )
    throw Error("Untrusted release archive location");
  const archive = await body(
    await fetcher(url.href, { signal, redirect: "error" }),
    16 * 1024 * 1024,
    signal,
  );
  if (
    "sha512-" + createHash("sha512").update(archive).digest("base64") !==
    release.dist.integrity
  )
    throw Error("Release archive integrity mismatch");
  const files = companyOsTar(archive),
    get = (path: string) => {
      const bytes = files.get("package/" + path);
      if (!bytes) throw Error("Missing npm distribution file");
      return bytes;
    };
  const pkg = JSON.parse(get("package.json").toString()),
    manifestRaw = get("distribution-manifest.json"),
    manifest = JSON.parse(manifestRaw.toString());
  if (
    pkg.name !== "@mosnin/companyos" ||
    pkg.version !== latest ||
    get("VERSION").toString().trim() !== latest ||
    manifest.distribution_version !== latest ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 2000
  )
    throw Error("Package distribution version mismatch");
  const seen = new Set<string>();
  let total = 0;
  const contents = manifest.files.map(
    (f: { path: string; size: number; sha256: string }) => {
      if (
        typeof f.path !== "string" ||
        !/^(company-os|autonomy-suite)\/[A-Za-z0-9_./-]+$/.test(f.path) ||
        f.path.split("/").some((p) => !p || p === "." || p === "..") ||
        seen.has(f.path) ||
        !Number.isSafeInteger(f.size) ||
        f.size < 0 ||
        f.size > 4 * 1024 * 1024
      )
        throw Error("Unsafe distribution path");
      seen.add(f.path);
      total += f.size;
      const bytes = get("skills/" + f.path),
        text = bytes.toString("utf8");
      if (
        bytes.length !== f.size ||
        hash(bytes) !== f.sha256 ||
        !Buffer.from(text).equals(bytes)
      )
        throw Error("Distribution file integrity mismatch");
      return { path: f.path, sha256: f.sha256, bytes: f.size, text };
    },
  );
  if (total > 16 * 1024 * 1024 || !seen.has("company-os/company-os/SKILL.md"))
    throw Error("Incomplete or oversized framework distribution");
  const bundle = Buffer.from(
    JSON.stringify({
      schema: 1,
      package: "@mosnin/companyos",
      version: latest,
      revision: release.gitHead,
      repository: "https://github.com/mosnin/companyos",
      license: pkg.license,
      distributionSha256: hash(manifestRaw),
      files: contents,
    }),
  );
  if (bundle.length > 20 * 1024 * 1024)
    throw Error("Framework bundle exceeds limit");
  return {
    state: "available" as const,
    version: latest,
    bundle,
    release: {
      version: latest,
      revision: release.gitHead,
      sha256: hash(bundle),
    },
  };
}
