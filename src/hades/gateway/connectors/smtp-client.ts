/**
 * A minimal, hand-rolled SMTP client (EHLO / AUTH PLAIN / MAIL FROM / RCPT TO
 * / DATA / QUIT) speaking over an injectable {@link TextSocket}. This is the
 * only file in the connector allowed to import `node:net`/`node:tls` — every
 * other module talks to a fake socket in tests.
 */
import * as net from "node:net";
import * as tls from "node:tls";
import type { OutgoingEmail } from "./email";

/** A line-oriented, already-decoded-to-text duplex socket. */
export interface TextSocket {
  write(data: string): void;
  onData(cb: (chunk: string) => void): void;
  onError(cb: (err: Error) => void): void;
  end(): void;
}

export type TextSocketFactory = (host: string, port: number, tls: boolean) => Promise<TextSocket>;

/** Real socket factory backed by node:net / node:tls. Only dialed outside of tests. */
export function nodeTlsSocketFactory(): TextSocketFactory {
  return (host, port, useTls) =>
    new Promise<TextSocket>((resolve, reject) => {
      const onConnect = () => {
        socket.removeListener("error", onFirstError);
        socket.setEncoding("utf8");
        resolve({
          write(data: string) {
            socket.write(data);
          },
          onData(cb: (chunk: string) => void) {
            socket.on("data", (chunk: string) => cb(chunk));
          },
          onError(cb: (err: Error) => void) {
            socket.on("error", cb);
          },
          end() {
            socket.end();
          },
        });
      };
      const onFirstError = (err: Error) => reject(err);
      const socket: net.Socket = useTls
        ? tls.connect({ host, port }, onConnect)
        : net.connect({ host, port }, onConnect);
      socket.once("error", onFirstError);
    });
}

export interface SmtpClientOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  socketFactory?: TextSocketFactory;
  timeoutMs?: number;
}

/** Parses SMTP replies off a {@link TextSocket}, resolving one reply block per `readReply()` call. */
class SmtpReplyReader {
  private buffer = "";
  private currentLines: string[] = [];
  private queue: string[][] = [];
  private closedErr: Error | null = null;
  private waiter: { resolve: (lines: string[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;

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
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.currentLines.push(line);
      // Continuation lines look like "250-...", the final line of a reply is "250 ...".
      const isFinal = !(line.length >= 4 && line[3] === "-");
      if (isFinal) {
        const lines = this.currentLines;
        this.currentLines = [];
        this.deliver(lines);
      }
    }
  }

  private deliver(lines: string[]): void {
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const resolve = this.waiter.resolve;
      this.waiter = null;
      resolve(lines);
    } else {
      this.queue.push(lines);
    }
  }

  readReply(): Promise<string[]> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as string[]);
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error(`SMTP command timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
}

/**
 * Envelope addresses are interpolated into `MAIL FROM:<...>` / `RCPT TO:<...>`
 * command lines, so CR/LF (command injection) and angle brackets (envelope
 * delimiter confusion) are rejected outright. Defense in depth: the To
 * addresses were already injection-checked when buildMessage assembled the
 * headers, but this client is a public API and must be safe standalone.
 */
function assertSafeEnvelopeAddress(addr: string, label: string): void {
  if (/[\r\n<>]/.test(addr)) {
    throw new Error(`SMTP ${label} address contains illegal characters (rejected a potential command injection)`);
  }
}

/** Normalize any bare LF to CRLF and dot-stuff lines starting with "." per RFC5321 §4.5.2. */
function normalizeAndDotStuff(raw: string): string {
  const lfNormalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = lfNormalized.split("\n").map((line) => (line.startsWith(".") ? `.${line}` : line));
  return lines.join("\r\n");
}

function replyCode(lines: string[]): number {
  const last = lines[lines.length - 1] ?? "";
  const code = parseInt(last.slice(0, 3), 10);
  return Number.isNaN(code) ? 0 : code;
}

/** Minimal SMTP client: EHLO -> AUTH PLAIN -> MAIL FROM -> RCPT TO* -> DATA -> QUIT. */
export class SmtpClient {
  constructor(private readonly opts: SmtpClientOptions) {}

  async sendMail(from: string, mail: OutgoingEmail & { raw: string }): Promise<void> {
    assertSafeEnvelopeAddress(from, "MAIL FROM");
    for (const rcpt of mail.to) assertSafeEnvelopeAddress(rcpt.address, "RCPT TO");
    const factory = this.opts.socketFactory ?? nodeTlsSocketFactory();
    const timeoutMs = this.opts.timeoutMs ?? 10_000;
    const socket = await factory(this.opts.host, this.opts.port, true);
    const reader = new SmtpReplyReader(socket, timeoutMs);

    const run = async (label: string, cmd: string | null, isOk: (code: number) => boolean = defaultOk): Promise<string[]> => {
      if (cmd !== null) socket.write(`${cmd}\r\n`);
      const lines = await reader.readReply();
      if (!isOk(replyCode(lines))) {
        throw new Error(`SMTP ${label} failed: ${lines.join(" | ")}`);
      }
      return lines;
    };

    try {
      await run("greeting", null);
      await run("EHLO", "EHLO hades-email-connector");
      const authToken = Buffer.from(`\0${this.opts.user}\0${this.opts.pass}`, "utf8").toString("base64");
      await run("AUTH PLAIN", `AUTH PLAIN ${authToken}`);
      await run("MAIL FROM", `MAIL FROM:<${from}>`);
      for (const rcpt of mail.to) {
        await run("RCPT TO", `RCPT TO:<${rcpt.address}>`);
      }
      await run("DATA", "DATA", (code) => code === 354);
      const stuffed = normalizeAndDotStuff(mail.raw);
      socket.write(`${stuffed}\r\n.\r\n`);
      await run("DATA body", null);
      await run("QUIT", "QUIT");
    } finally {
      socket.end();
    }
  }
}

function defaultOk(code: number): boolean {
  return code >= 200 && code < 400;
}
