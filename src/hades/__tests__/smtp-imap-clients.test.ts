import { describe, it, expect } from "vitest";
import { SmtpClient } from "../gateway/connectors/smtp-client";
import type { TextSocket, TextSocketFactory } from "../gateway/connectors/smtp-client";
import { ImapClient } from "../gateway/connectors/imap-client";

/**
 * A fully scripted fake socket: `onData` is driven by whatever the test
 * pushes via `deliver()`, and every `write()` call is recorded so tests can
 * assert on exactly what was sent on the wire.
 */
function fakeSocket(): TextSocket & { writes: string[]; deliver(chunk: string): void; fail(err: Error): void } {
  const dataCbs: Array<(chunk: string) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  const writes: string[] = [];
  // Chunks delivered before any onData listener is attached (e.g. a server
  // greeting that "arrives" the instant the socket is handed back) would
  // otherwise be lost, unlike a real socket where the connect callback (and
  // therefore listener registration) always precedes any inbound bytes.
  const pending: string[] = [];
  return {
    writes,
    write(data: string) {
      writes.push(data);
    },
    onData(cb) {
      dataCbs.push(cb);
      while (pending.length > 0) cb(pending.shift() as string);
    },
    onError(cb) {
      errorCbs.push(cb);
    },
    end() {},
    deliver(chunk: string) {
      if (dataCbs.length === 0) {
        pending.push(chunk);
        return;
      }
      for (const cb of dataCbs) cb(chunk);
    },
    fail(err: Error) {
      for (const cb of errorCbs) cb(err);
    },
  };
}

/** A scripted factory: responds to each written command by looking it up (by prefix) in a script, replying async. */
function scriptedFactory(script: Array<{ match: RegExp; reply: string }>): { factory: TextSocketFactory; socket: ReturnType<typeof fakeSocket> } {
  const socket = fakeSocket();
  const originalWrite = socket.write.bind(socket);
  socket.write = (data: string) => {
    originalWrite(data);
    const rule = script.find((r) => r.match.test(data));
    if (rule) {
      queueMicrotask(() => socket.deliver(rule.reply));
    }
  };
  const factory: TextSocketFactory = async () => socket;
  return { factory, socket };
}

describe("SmtpClient", () => {
  it("runs the full EHLO -> AUTH -> MAIL FROM -> RCPT TO -> DATA -> QUIT sequence and tolerates multiline EHLO", async () => {
    const { factory, socket } = scriptedFactory([
      { match: /^EHLO/, reply: "250-mail.example.com Hello\r\n250-PIPELINING\r\n250-8BITMIME\r\n250 AUTH PLAIN\r\n" },
      { match: /^AUTH PLAIN/, reply: "235 Authentication succeeded\r\n" },
      { match: /^MAIL FROM/, reply: "250 OK\r\n" },
      { match: /^RCPT TO/, reply: "250 OK\r\n" },
      { match: /^DATA\r\n/, reply: "354 Start mail input\r\n" },
      { match: /\r\n\.\r\n$/, reply: "250 OK: queued\r\n" },
      { match: /^QUIT/, reply: "221 Bye\r\n" },
    ]);
    // Greeting arrives immediately on "connect".
    queueMicrotask(() => socket.deliver("220 mail.example.com ESMTP ready\r\n"));

    const client = new SmtpClient({ host: "smtp.example.com", port: 465, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });
    await client.sendMail("from@example.com", {
      to: [{ address: "to@example.com" }],
      subject: "hi",
      text: "hello",
      raw: "Subject: hi\r\n\r\nhello",
    });

    const sentCommands = socket.writes.map((w) => w.split("\r\n")[0]);
    expect(sentCommands).toContain("EHLO hades-email-connector");
    expect(sentCommands.some((c) => c.startsWith("AUTH PLAIN "))).toBe(true);
    expect(sentCommands).toContain("MAIL FROM:<from@example.com>");
    expect(sentCommands).toContain("RCPT TO:<to@example.com>");
    expect(sentCommands).toContain("DATA");
    expect(sentCommands).toContain("QUIT");
  });

  it("sends to every recipient with its own RCPT TO", async () => {
    const { factory, socket } = scriptedFactory([
      { match: /^EHLO/, reply: "250 OK\r\n" },
      { match: /^AUTH PLAIN/, reply: "235 OK\r\n" },
      { match: /^MAIL FROM/, reply: "250 OK\r\n" },
      { match: /^RCPT TO/, reply: "250 OK\r\n" },
      { match: /^DATA\r\n/, reply: "354 Go\r\n" },
      { match: /\r\n\.\r\n$/, reply: "250 OK\r\n" },
      { match: /^QUIT/, reply: "221 Bye\r\n" },
    ]);
    queueMicrotask(() => socket.deliver("220 ready\r\n"));
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "p", socketFactory: factory });
    await client.sendMail("from@example.com", {
      to: [{ address: "a@example.com" }, { address: "b@example.com" }],
      subject: "s",
      text: "t",
      raw: "Subject: s\r\n\r\nt",
    });
    const rcpts = socket.writes.filter((w) => w.startsWith("RCPT TO"));
    expect(rcpts).toEqual(["RCPT TO:<a@example.com>\r\n", "RCPT TO:<b@example.com>\r\n"]);
  });

  it("surfaces the server's 535 line when AUTH fails", async () => {
    const { factory, socket } = scriptedFactory([
      { match: /^EHLO/, reply: "250 OK\r\n" },
      { match: /^AUTH PLAIN/, reply: "535 5.7.8 Authentication credentials invalid\r\n" },
    ]);
    queueMicrotask(() => socket.deliver("220 ready\r\n"));
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "wrong", socketFactory: factory });
    await expect(
      client.sendMail("from@example.com", { to: [{ address: "to@example.com" }], subject: "s", text: "t", raw: "x" })
    ).rejects.toThrow(/535.*Authentication credentials invalid/);
  });

  it("rejects on any 4xx/5xx reply mid-transaction (RCPT TO refused)", async () => {
    const { factory, socket } = scriptedFactory([
      { match: /^EHLO/, reply: "250 OK\r\n" },
      { match: /^AUTH PLAIN/, reply: "235 OK\r\n" },
      { match: /^MAIL FROM/, reply: "250 OK\r\n" },
      { match: /^RCPT TO/, reply: "550 5.1.1 No such user\r\n" },
    ]);
    queueMicrotask(() => socket.deliver("220 ready\r\n"));
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "p", socketFactory: factory });
    await expect(
      client.sendMail("from@example.com", { to: [{ address: "nobody@example.com" }], subject: "s", text: "t", raw: "x" })
    ).rejects.toThrow(/550/);
  });

  it("dot-stuffs a body line starting with '.' so it arrives '..'-escaped, and normalizes bare LF to CRLF", async () => {
    const { factory, socket } = scriptedFactory([
      { match: /^EHLO/, reply: "250 OK\r\n" },
      { match: /^AUTH PLAIN/, reply: "235 OK\r\n" },
      { match: /^MAIL FROM/, reply: "250 OK\r\n" },
      { match: /^RCPT TO/, reply: "250 OK\r\n" },
      { match: /^DATA\r\n/, reply: "354 Go\r\n" },
      { match: /\r\n\.\r\n$/, reply: "250 OK\r\n" },
      { match: /^QUIT/, reply: "221 Bye\r\n" },
    ]);
    queueMicrotask(() => socket.deliver("220 ready\r\n"));
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "p", socketFactory: factory });
    const rawWithLfOnly = "Subject: s\n\nline one\n.this line starts with a dot\nlast line";
    await client.sendMail("from@example.com", {
      to: [{ address: "to@example.com" }],
      subject: "s",
      text: "t",
      raw: rawWithLfOnly,
    });
    const dataWrite = socket.writes.find((w) => w.includes("this line starts with a dot"));
    expect(dataWrite).toBeDefined();
    expect(dataWrite).toContain("..this line starts with a dot");
    expect(dataWrite).not.toContain("\n.this line"); // no bare LF survived
    expect(dataWrite!.endsWith("\r\n.\r\n")).toBe(true);
  });

  it("rejects with a timeout error instead of hanging when a command gets no reply", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    // Only answer the greeting; every subsequent command is left hanging.
    queueMicrotask(() => socket.deliver("220 ready\r\n"));
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "p", socketFactory: factory, timeoutMs: 20 });
    await expect(
      client.sendMail("from@example.com", { to: [{ address: "to@example.com" }], subject: "s", text: "t", raw: "x" })
    ).rejects.toThrow(/timed out/);
  });
});

describe("ImapClient", () => {
  it("logs in, selects, searches, fetches literals, and logs out, returning parsed uid/raw pairs", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "imap.example.com", port: 993, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });

    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("a001 OK LOGIN completed\r\n"));
      if (/^a002 SELECT INBOX/.test(data)) queueMicrotask(() => socket.deliver("* 5 EXISTS\r\n* 0 RECENT\r\na002 OK [READ-WRITE] SELECT completed\r\n"));
      if (/^a003 UID SEARCH/.test(data)) queueMicrotask(() => socket.deliver("* SEARCH 12 13\r\na003 OK SEARCH completed\r\n"));
      if (/^a004 UID FETCH/.test(data)) {
        const msg1 = "Subject: one\r\n\r\nbody one";
        const msg2 = "Subject: two\r\n\r\nbody two";
        queueMicrotask(() =>
          socket.deliver(
            `* 1 FETCH (UID 12 BODY[] {${msg1.length}}\r\n${msg1})\r\n` +
              `* 2 FETCH (UID 13 BODY[] {${msg2.length}}\r\n${msg2})\r\n` +
              "a004 OK FETCH completed\r\n"
          )
        );
      }
      if (/^a005 LOGOUT/.test(data)) queueMicrotask(() => socket.deliver("* BYE Logging out\r\na005 OK LOGOUT completed\r\n"));
    };

    const results = await client.fetchNewer(11);
    expect(results).toEqual([
      { uid: 12, raw: "Subject: one\r\n\r\nbody one" },
      { uid: 13, raw: "Subject: two\r\n\r\nbody two" },
    ]);
    expect(socket.writes.some((w) => w.startsWith("a003 UID SEARCH UID 12:*"))).toBe(true);
    expect(socket.writes.some((w) => w.startsWith("a004 UID FETCH 12,13"))).toBe(true);
  });

  it("parses a literal split across multiple onData chunks (chunk boundary mid-literal)", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "h", port: 993, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });

    const msg = "Subject: chunked\r\n\r\nthis body is delivered across several chunks";
    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("a001 OK\r\n"));
      if (/^a002 SELECT/.test(data)) queueMicrotask(() => socket.deliver("a002 OK\r\n"));
      if (/^a003 UID SEARCH/.test(data)) queueMicrotask(() => socket.deliver("* SEARCH 99\r\na003 OK\r\n"));
      if (/^a004 UID FETCH/.test(data)) {
        queueMicrotask(async () => {
          const head = `* 1 FETCH (UID 99 BODY[] {${msg.length}}\r\n`;
          // Split the literal itself across three arbitrary chunk boundaries.
          const mid = Math.floor(msg.length / 3);
          const chunks = [head + msg.slice(0, mid), msg.slice(mid, mid * 2), msg.slice(mid * 2) + ")\r\n", "a004 OK\r\n"];
          for (const c of chunks) {
            socket.deliver(c);
            await Promise.resolve();
          }
        });
      }
      if (/^a005 LOGOUT/.test(data)) queueMicrotask(() => socket.deliver("a005 OK\r\n"));
    };

    const results = await client.fetchNewer(98);
    expect(results).toEqual([{ uid: 99, raw: msg }]);
  });

  it("returns an empty array on an empty SEARCH result (no FETCH issued)", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "h", port: 993, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });
    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("a001 OK\r\n"));
      if (/^a002 SELECT/.test(data)) queueMicrotask(() => socket.deliver("a002 OK\r\n"));
      if (/^a003 UID SEARCH/.test(data)) queueMicrotask(() => socket.deliver("* SEARCH\r\na003 OK\r\n"));
      if (/^a004 LOGOUT/.test(data)) queueMicrotask(() => socket.deliver("a004 OK\r\n"));
    };
    const results = await client.fetchNewer(1000);
    expect(results).toEqual([]);
    expect(socket.writes.some((w) => w.startsWith("UID FETCH") || / UID FETCH/.test(w))).toBe(false);
  });

  it("throws on a NO response", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "h", port: 993, user: "wrong", pass: "wrong", socketFactory: factory, timeoutMs: 2000 });
    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("a001 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n"));
    };
    await expect(client.fetchNewer(0)).rejects.toThrow(/NO/);
  });

  it("throws on a BAD response", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "h", port: 993, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });
    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("a001 OK\r\n"));
      if (/^a002 SELECT/.test(data)) queueMicrotask(() => socket.deliver("a002 BAD Command unrecognized\r\n"));
    };
    await expect(client.fetchNewer(0)).rejects.toThrow(/BAD/);
  });

  it("tolerates untagged lines interleaved with the tagged completion", async () => {
    const socket = fakeSocket();
    const factory: TextSocketFactory = async () => socket;
    const client = new ImapClient({ host: "h", port: 993, user: "u", pass: "p", socketFactory: factory, timeoutMs: 2000 });
    const originalWrite = socket.write.bind(socket);
    socket.write = (data: string) => {
      originalWrite(data);
      if (/^a001 LOGIN/.test(data)) queueMicrotask(() => socket.deliver("* OK IMAP4rev1 ready\r\na001 OK LOGIN completed\r\n"));
      if (/^a002 SELECT/.test(data))
        queueMicrotask(() => socket.deliver("* 10 EXISTS\r\n* 2 RECENT\r\n* FLAGS (\\Seen \\Answered)\r\na002 OK SELECT completed\r\n"));
      if (/^a003 UID SEARCH/.test(data)) queueMicrotask(() => socket.deliver("* SEARCH\r\na003 OK\r\n"));
      if (/^a004 LOGOUT/.test(data)) queueMicrotask(() => socket.deliver("* BYE\r\na004 OK\r\n"));
    };
    await expect(client.fetchNewer(0)).resolves.toEqual([]);
  });
});
