import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatMessage } from "../models/client";

export interface ContextArchive {
  /** Must durably retain the full message before returning its reference. */
  put(message: ChatMessage): string;
  read(reference: string, offset: number, limit: number): { content: string; nextOffset?: number; totalChars: number };
}

/** Content-addressed evidence for a single desktop turn. This is a context
 * archive, not an execution journal: it never replays a tool or grants approval.
 */
export class FileContextArchive implements ContextArchive {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  put(message: ChatMessage): string {
    const body = JSON.stringify(message);
    const reference = createHash("sha256").update(body).digest("hex");
    const path = join(this.directory, reference + ".json");
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") !== body) throw new Error("Context archive integrity check failed");
      return reference;
    }
    const temporary = path + ".pending";
    const fd = openSync(temporary, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); }
    catch (error) { unlinkSync(temporary); throw error; }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    const directoryFd = openSync(this.directory, "r");
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return reference;
  }
  read(reference: string, offset: number, limit: number) {
    if (!/^[a-f0-9]{64}$/.test(reference)) throw new Error("Invalid context reference");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 12000)
      throw new Error("Use a nonnegative offset and a limit from 1 to 12000");
    const body = readFileSync(join(this.directory, reference + ".json"), "utf8");
    if (createHash("sha256").update(body).digest("hex") !== reference) throw new Error("Context archive integrity check failed");
    if (offset > body.length) throw new Error("Offset exceeds archived message length");
    return { content: body.slice(offset, offset + limit), totalChars: body.length,
      ...(offset + limit < body.length ? { nextOffset: offset + limit } : {}) };
  }
}
