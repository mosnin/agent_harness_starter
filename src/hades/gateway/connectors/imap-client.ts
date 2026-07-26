/**
 * A minimal, hand-rolled IMAP client (LOGIN / SELECT / UID SEARCH / UID FETCH
 * / LOGOUT) speaking over the same injectable {@link TextSocket} abstraction
 * as the SMTP client. Understands IMAP literals (`{N}\r\n<N bytes>`) split
 * across arbitrary chunk boundaries, and tolerates untagged `*` lines.
 */
import type { TextSocket, TextSocketFactory } from "./smtp-client";
import { nodeTlsSocketFactory } from "./smtp-client";

export interface ImapClientOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  socketFactory?: TextSocketFactory;
  timeoutMs?: number;
}

type ResponsePart = { kind: "text"; value: string } | { kind: "literal"; value: string };

interface ResponseLine {
  parts: ResponsePart[];
}

function lineText(l: ResponseLine): string {
  return l.parts.map((p) => p.value).join("");
}

/**
 * Streams socket chunks into logical IMAP response lines, transparently
 * consuming `{N}` literals (which may span multiple `onData` chunks) as part
 * of the same logical line. `readUntilTagged` resolves once the tagged
 * completion line for a given tag has been seen, returning every line
 * (untagged and tagged) collected since the previous call.
 */
class ImapResponseReader {
  private buffer = "";
  private pendingLiteral: number | null = null;
  private currentParts: ResponsePart[] = [];
  private lines: ResponseLine[] = [];
  private closedErr: Error | null = null;
  private waiter: { tag: string; resolve: (lines: ResponseLine[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null =
    null;

  constructor(
    socket: TextSocket,
    private readonly timeoutMs: number
  ) {
    socket.onData((chunk) => {
      this.buffer += chunk;
      this.pump();
    });
    socket.onError((err) => {
      this.closedErr = err;
      if (this.waiter) {
        clearTimeout(this.waiter.timer);
        this.waiter.reject(err);
        this.waiter = null;
      }
    });
  }

  private pump(): void {
    for (;;) {
      if (this.pendingLiteral !== null) {
        if (this.buffer.length < this.pendingLiteral) return;
        const data = this.buffer.slice(0, this.pendingLiteral);
        this.buffer = this.buffer.slice(this.pendingLiteral);
        this.currentParts.push({ kind: "literal", value: data });
        this.pendingLiteral = null;
        continue;
      }
      const nlIdx = this.buffer.indexOf("\n");
      if (nlIdx === -1) return;
      let rawLine = this.buffer.slice(0, nlIdx);
      this.buffer = this.buffer.slice(nlIdx + 1);
      if (rawLine.endsWith("\r")) rawLine = rawLine.slice(0, -1);

      const litMatch = /\{(\d+)\}\s*$/.exec(rawLine);
      if (litMatch) {
        const textBefore = rawLine.slice(0, litMatch.index);
        this.currentParts.push({ kind: "text", value: textBefore });
        this.pendingLiteral = parseInt(litMatch[1], 10);
        continue; // logical line continues after the literal bytes arrive
      }
      this.currentParts.push({ kind: "text", value: rawLine });
      const line: ResponseLine = { parts: this.currentParts };
      this.currentParts = [];
      this.onLine(line);
    }
  }

  private onLine(line: ResponseLine): void {
    this.lines.push(line);
    this.tryDeliver();
  }

  private tryDeliver(): void {
    if (!this.waiter) return;
    for (let i = 0; i < this.lines.length; i++) {
      if (lineText(this.lines[i]).startsWith(`${this.waiter.tag} `)) {
        const collected = this.lines.slice(0, i + 1);
        this.lines = this.lines.slice(i + 1);
        clearTimeout(this.waiter.timer);
        const resolve = this.waiter.resolve;
        this.waiter = null;
        resolve(collected);
        return;
      }
    }
  }

  readUntilTagged(tag: string): Promise<ResponseLine[]> {
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise<ResponseLine[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`IMAP command ${tag} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiter = { tag, resolve, reject, timer };
      this.tryDeliver();
    });
  }
}

function quoteImapString(s: string): string {
  // An IMAP quoted string cannot legally carry CR/LF/NUL (RFC 3501 §4.3) —
  // and letting one through would splice extra commands into the LOGIN line.
  // Refusing honestly beats silently mangling a credential.
  if (/[\r\n\0]/.test(s)) {
    throw new Error("IMAP quoted string cannot contain CR, LF, or NUL (rejected a potential command injection)");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function extractSearchUids(lines: ResponseLine[]): number[] {
  for (const l of lines) {
    const text = lineText(l).trim();
    const m = /^\*\s+SEARCH\b(.*)$/i.exec(text);
    if (m) {
      return m[1]
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map((s) => parseInt(s, 10))
        .filter((n) => !Number.isNaN(n));
    }
  }
  return [];
}

function extractFetchResults(lines: ResponseLine[]): { uid: number; raw: string }[] {
  const out: { uid: number; raw: string }[] = [];
  for (const l of lines) {
    const text = lineText(l);
    const fetchMatch = /^\*\s+(\d+)\s+FETCH/i.exec(text.trimStart());
    if (!fetchMatch) continue;
    const uidMatch = /\bUID\s+(\d+)/i.exec(text);
    const uid = uidMatch ? parseInt(uidMatch[1], 10) : parseInt(fetchMatch[1], 10);
    const literal = l.parts.find((p): p is { kind: "literal"; value: string } => p.kind === "literal");
    if (literal) out.push({ uid, raw: literal.value });
  }
  return out;
}

/** Minimal IMAP client: LOGIN -> SELECT INBOX -> UID SEARCH -> UID FETCH (BODY.PEEK[]) -> LOGOUT. */
export class ImapClient {
  constructor(private readonly opts: ImapClientOptions) {}

  async fetchNewer(sinceUid: number): Promise<{ uid: number; raw: string }[]> {
    const factory = this.opts.socketFactory ?? nodeTlsSocketFactory();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const socket = await factory(this.opts.host, this.opts.port, true);
    const reader = new ImapResponseReader(socket, timeoutMs);
    let tagCounter = 0;
    const nextTag = () => `a${String(++tagCounter).padStart(3, "0")}`;

    const runTagged = async (cmd: string): Promise<ResponseLine[]> => {
      const tag = nextTag();
      socket.write(`${tag} ${cmd}\r\n`);
      const lines = await reader.readUntilTagged(tag);
      const taggedText = lineText(lines[lines.length - 1]);
      if (/^\S+\s+(BAD|NO)\b/i.test(taggedText)) {
        throw new Error(`IMAP command "${cmd}" failed: ${taggedText}`);
      }
      return lines;
    };

    try {
      await runTagged(`LOGIN ${quoteImapString(this.opts.user)} ${quoteImapString(this.opts.pass)}`);
      await runTagged("SELECT INBOX");
      const searchLines = await runTagged(`UID SEARCH UID ${sinceUid + 1}:*`);
      const uids = extractSearchUids(searchLines);
      if (uids.length === 0) {
        await runTagged("LOGOUT");
        return [];
      }
      const fetchLines = await runTagged(`UID FETCH ${uids.join(",")} (BODY.PEEK[])`);
      const results = extractFetchResults(fetchLines);
      await runTagged("LOGOUT");
      return results;
    } finally {
      socket.end();
    }
  }
}
