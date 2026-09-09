#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
if (!process.argv[2]) throw new Error("Provide the bundle Resources directory");
const resources = resolve(process.argv[2]);
const path = join(resources, "helm-ui/helm-provenance.json");
const data = JSON.parse(readFileSync(path, "utf8"));
data.runtimeSha256 = createHash("sha256").update(readFileSync(join(resources, "helm-opencode"))).digest("hex");
writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
