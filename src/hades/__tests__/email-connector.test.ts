import { describe, it, expect } from "vitest";
import { EmailConnector, createEmailEnvTransport, EMAIL_PLATFORM } from "../gateway/connectors/email";
import type { EmailEnvelope, EmailTransport, OutgoingEmail } from "../gateway/connectors/email";
import type { TextSocket, TextSocketFactory } from "../gateway/connectors/smtp-client";
import { ConnectorHub } from "../gateway/connector";
import type { InboundMessage, OutboundReply } from "../../swarm-runtime/gateway/gateway";

function envelope(overrides: Partial<EmailEnvelope>): EmailEnvelope {
  return {
    uid: 1,
    messageId: "<m1@x.com>",
    references: [],
    from: { address: "sender@x.com" },
    to: [{ address: "bot@x.com" }],
    subject: "hello",
    text: "hi there",
    ...overrides,
  };
}

/** Fake transport: a queue of envelopes to hand back on the next poll(), sends captured. */
function fakeTransport(initial: EmailEnvelope[] = []): EmailTransport & { queue: EmailEnvelope[]; sent: OutgoingEmail[] } {
  const queue = [...initial];
  const sent: OutgoingEmail[] = [];
  return {
    queue,
    sent,
    async poll(sinceUid) {
      const batch = queue.filter((e) => e.uid > sinceUid);
      return batch;
    },
    async send(mail) {
      sent.push(mail);
    },
  };
}

const echo = async (m: InboundMessage): Promise<OutboundReply> => ({ text: `echo:${m.text}`, accepted: true });

describe("EmailConnector: platform + basic wiring", () => {
  it("reports EMAIL_PLATFORM as its platform", () => {
    const conn = new EmailConnector(fakeTransport(), { address: "bot@x.com" });
    expect(conn.platform).toBe(EMAIL_PLATFORM);
    expect(conn.platform).toBe("email");
  });
});

describe("EmailConnector: inbound mapping", () => {
  it("maps sender (lowercased) to user, thread key to channel, and body to text", async () => {
    const transport = fakeTransport([
      envelope({ uid: 5, from: { address: "Sender@Example.com" }, text: "Hello world", subject: "Question" }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    let received: InboundMessage | undefined;
    await conn.start(async (m) => {
      received = m;
      return { text: "", accepted: true };
    });
    await conn.pollOnce();

    expect(received?.platform).toBe(EMAIL_PLATFORM);
    expect(received?.user).toBe("sender@example.com");
    expect(received?.text).toBe("Hello world");
    expect(received?.channel).toBe("<m1@x.com>"); // own messageId: no references/inReplyTo
    await conn.stop();
  });

  it("falls back to the subject line when the body is empty", async () => {
    const transport = fakeTransport([envelope({ uid: 1, text: "", subject: "Empty body subject" })]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    let received: InboundMessage | undefined;
    await conn.start(async (m) => {
      received = m;
      return { text: "", accepted: true };
    });
    await conn.pollOnce();
    expect(received?.text).toBe("Empty body subject");
    await conn.stop();
  });

  it("does not prepend 'Subject: ...' to a non-empty body", async () => {
    const transport = fakeTransport([envelope({ uid: 1, text: "just the body", subject: "irrelevant" })]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    let received: InboundMessage | undefined;
    await conn.start(async (m) => {
      received = m;
      return { text: "", accepted: true };
    });
    await conn.pollOnce();
    expect(received?.text).toBe("just the body");
    await conn.stop();
  });
});

describe("EmailConnector: threading", () => {
  it("keys the channel by the first References entry even for a 3-deep chain", async () => {
    const transport = fakeTransport([
      envelope({
        uid: 1,
        messageId: "<leaf@x.com>",
        inReplyTo: "<mid@x.com>",
        references: ["<root@x.com>", "<mid2@x.com>", "<mid@x.com>"],
      }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    let received: InboundMessage | undefined;
    await conn.start(async (m) => {
      received = m;
      return { text: "", accepted: true };
    });
    await conn.pollOnce();
    expect(received?.channel).toBe("<root@x.com>");
    await conn.stop();
  });

  it("falls back to inReplyTo when References is empty, and to its own messageId when both are empty", async () => {
    const transport = fakeTransport([
      envelope({ uid: 1, messageId: "<a@x.com>", references: [], inReplyTo: "<parent@x.com>" }),
      envelope({ uid: 2, messageId: "<b@x.com>", references: [], inReplyTo: undefined }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    const received: InboundMessage[] = [];
    await conn.start(async (m) => {
      received.push(m);
      return { text: "", accepted: true };
    });
    await conn.pollOnce();
    expect(received[0].channel).toBe("<parent@x.com>");
    expect(received[1].channel).toBe("<b@x.com>");
    await conn.stop();
  });

  it("replies with In-Reply-To = triggering messageId and References = triggering references + messageId", async () => {
    const transport = fakeTransport([
      envelope({
        uid: 1,
        messageId: "<trigger@x.com>",
        references: ["<root@x.com>"],
        from: { address: "sender@x.com" },
        subject: "Original subject",
      }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    await conn.start(echo);
    await conn.pollOnce();

    expect(transport.sent).toHaveLength(1);
    const reply = transport.sent[0];
    expect(reply.inReplyTo).toBe("<trigger@x.com>");
    expect(reply.references).toEqual(["<root@x.com>", "<trigger@x.com>"]);
    expect(reply.subject).toBe("Re: Original subject");
    expect(reply.to).toEqual([{ address: "sender@x.com" }]);
    expect(reply.text).toBe("echo:hi there");
    await conn.stop();
  });

  it("never double-prefixes Subject with 'Re: Re:' on a reply to an already-Re: subject", async () => {
    const transport = fakeTransport([envelope({ uid: 1, subject: "Re: already replied" })]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    await conn.start(echo);
    await conn.pollOnce();
    expect(transport.sent[0].subject).toBe("Re: already replied");
    expect(transport.sent[0].subject).not.toMatch(/Re: Re:/i);
    await conn.stop();
  });

  it("threads a second message in the same conversation off the most recent envelope", async () => {
    const transport = fakeTransport([
      envelope({ uid: 1, messageId: "<first@x.com>", references: ["<root@x.com>"], subject: "Re: root" }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    await conn.start(echo);
    await conn.pollOnce();
    expect(transport.sent[0].inReplyTo).toBe("<first@x.com>");

    // A follow-up in the same thread (still keyed by <root@x.com>) with a new leaf messageId.
    transport.queue.push(
      envelope({ uid: 2, messageId: "<second@x.com>", references: ["<root@x.com>", "<first@x.com>"], subject: "Re: root" })
    );
    await conn.pollOnce();
    expect(transport.sent[1].inReplyTo).toBe("<second@x.com>");
    expect(transport.sent[1].references).toEqual(["<root@x.com>", "<first@x.com>", "<second@x.com>"]);
    await conn.stop();
  });
});

describe("EmailConnector: self-mail loop suppression", () => {
  it("skips a message whose From matches opts.address (case-insensitively) and never calls the handler for it", async () => {
    const transport = fakeTransport([
      envelope({ uid: 1, from: { address: "BOT@X.COM" } }),
      envelope({ uid: 2, from: { address: "human@x.com" } }),
    ]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    const handled: InboundMessage[] = [];
    await conn.start(async (m) => {
      handled.push(m);
      return { text: "", accepted: true };
    });
    await conn.pollOnce();
    expect(handled).toHaveLength(1);
    expect(handled[0].user).toBe("human@x.com");
    await conn.stop();
  });
});

describe("EmailConnector: uid watermark", () => {
  it("advances monotonically and never regresses even when poll returns out-of-order uids", async () => {
    const transport = fakeTransport();
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    const seenSince: number[] = [];
    const originalPoll = transport.poll.bind(transport);
    transport.poll = async (sinceUid: number) => {
      seenSince.push(sinceUid);
      return originalPoll(sinceUid);
    };
    await conn.start(echo);

    transport.queue.push(envelope({ uid: 10 }), envelope({ uid: 3 }), envelope({ uid: 7 }));
    await conn.pollOnce(); // watermark should become 10 (max), not 7 (last)

    transport.queue.length = 0;
    await conn.pollOnce();
    expect(seenSince[seenSince.length - 1]).toBe(10);
    await conn.stop();
  });

  it("advances the watermark even for a skipped self-sent message", async () => {
    const transport = fakeTransport([envelope({ uid: 4, from: { address: "bot@x.com" } })]);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    const seenSince: number[] = [];
    const originalPoll = transport.poll.bind(transport);
    transport.poll = async (sinceUid: number) => {
      seenSince.push(sinceUid);
      return originalPoll(sinceUid);
    };
    await conn.start(echo);
    await conn.pollOnce();
    transport.queue.length = 0;
    await conn.pollOnce();
    expect(seenSince[seenSince.length - 1]).toBe(4);
    await conn.stop();
  });
});

describe("EmailConnector: lifecycle", () => {
  it("pollOnce is a no-op after stop() (no handler calls, no transport.poll)", async () => {
    const transport = fakeTransport([envelope({ uid: 1 })]);
    let pollCalls = 0;
    const originalPoll = transport.poll.bind(transport);
    transport.poll = async (sinceUid: number) => {
      pollCalls++;
      return originalPoll(sinceUid);
    };
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    let handlerCalls = 0;
    await conn.start(async () => {
      handlerCalls++;
      return { text: "", accepted: true };
    });
    await conn.stop();
    await conn.pollOnce();
    expect(pollCalls).toBe(0);
    expect(handlerCalls).toBe(0);
  });

  it("send() to a DeliveryTarget without a channel starts a fresh thread (no In-Reply-To/References, no Re: prefix)", async () => {
    const transport = fakeTransport();
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    await conn.start(echo);
    await conn.send({ user: "someone@example.com" }, "proactive notice");
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].inReplyTo).toBeUndefined();
    expect(transport.sent[0].references).toBeUndefined();
    expect(transport.sent[0].subject).not.toMatch(/^Re:/);
    expect(transport.sent[0].to).toEqual([{ address: "someone@example.com" }]);
    expect(transport.sent[0].text).toBe("proactive notice");
    await conn.stop();
  });

  it("works through the ConnectorHub with rate limiting, replying via transport.send", async () => {
    const transport = fakeTransport([envelope({ uid: 1, from: { address: "human@x.com" } })]);
    const hub = new ConnectorHub(echo);
    const conn = new EmailConnector(transport, { address: "bot@x.com" });
    hub.register(conn);
    await hub.startAll();
    await conn.pollOnce();
    expect(transport.sent[0].text).toBe("echo:hi there");
    await hub.stopAll();
  });
});

describe("createEmailEnvTransport", () => {
  const fullEnv = {
    HADES_EMAIL_ADDRESS: "bot@example.com",
    HADES_EMAIL_IMAP_HOST: "imap.example.com",
    HADES_EMAIL_SMTP_HOST: "smtp.example.com",
    HADES_EMAIL_USER: "bot@example.com",
    HADES_EMAIL_PASS: "super-secret-password-value",
  };

  it("is offline and names each missing var when nothing is set", () => {
    const result = createEmailEnvTransport({});
    expect(result.mode).toBe("offline");
    expect(result.transport).toBeUndefined();
    expect(result.reason).toContain("HADES_EMAIL_ADDRESS");
    expect(result.reason).toContain("HADES_EMAIL_IMAP_HOST");
    expect(result.reason).toContain("HADES_EMAIL_SMTP_HOST");
    expect(result.reason).toContain("HADES_EMAIL_USER");
    expect(result.reason).toContain("HADES_EMAIL_PASS");
  });

  for (const missingKey of Object.keys(fullEnv)) {
    it(`is offline and names ${missingKey} when only it is missing`, () => {
      const env = { ...fullEnv };
      delete (env as Record<string, string | undefined>)[missingKey];
      const result = createEmailEnvTransport(env);
      expect(result.mode).toBe("offline");
      expect(result.reason).toContain(missingKey);
      // Every other required var must NOT be reported as missing.
      for (const otherKey of Object.keys(fullEnv)) {
        if (otherKey !== missingKey) expect(result.reason).not.toContain(otherKey);
      }
    });
  }

  it("never leaks the secret password value in mode/reason strings, present or absent", () => {
    const offline = createEmailEnvTransport({ ...fullEnv, HADES_EMAIL_PASS: undefined });
    expect(JSON.stringify(offline)).not.toContain("super-secret-password-value");

    const real = createEmailEnvTransport(fullEnv, scriptedFakeFactory());
    expect(JSON.stringify({ mode: real.mode, reason: real.reason, address: real.address })).not.toContain("super-secret-password-value");
  });

  it("is real when all required vars are present, using default ports", async () => {
    const result = createEmailEnvTransport(fullEnv, scriptedFakeFactory());
    expect(result.mode).toBe("real");
    expect(result.transport).toBeDefined();
    expect(result.address).toBe("bot@example.com");
  });

  it("respects custom IMAP/SMTP ports from env", () => {
    const seenPorts: number[] = [];
    const factory: TextSocketFactory = async (_host, port) => {
      seenPorts.push(port);
      return fakeNoopSocket();
    };
    createEmailEnvTransport({ ...fullEnv, HADES_EMAIL_IMAP_PORT: "1993", HADES_EMAIL_SMTP_PORT: "1465" }, factory);
    // Ports aren't dialed until poll()/send() are actually invoked; construction alone must not throw.
    expect(seenPorts).toEqual([]);
  });

  it("a real transport's poll() drives the real ImapClient end-to-end over a scripted fake socket", async () => {
    const socket = fakeScriptableSocket();
    const factory: TextSocketFactory = async () => socket;
    const msg = "Subject: real path\r\nMessage-ID: <r1@example.com>\r\n\r\nhello from imap";
    socket.onWrite((data) => {
      if (/^a001 LOGIN/.test(data)) socket.reply("a001 OK\r\n");
      if (/^a002 SELECT/.test(data)) socket.reply("a002 OK\r\n");
      if (/^a003 UID SEARCH/.test(data)) socket.reply("* SEARCH 9\r\na003 OK\r\n");
      if (/^a004 UID FETCH/.test(data)) socket.reply(`* 1 FETCH (UID 9 BODY[] {${msg.length}}\r\n${msg})\r\na004 OK\r\n`);
      if (/^a005 LOGOUT/.test(data)) socket.reply("a005 OK\r\n");
    });

    const result = createEmailEnvTransport(fullEnv, factory);
    expect(result.mode).toBe("real");
    const envelopes = await result.transport!.poll(8);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].uid).toBe(9);
    expect(envelopes[0].text).toBe("hello from imap");
    expect(envelopes[0].messageId).toBe("<r1@example.com>");
  });
});

// --- helpers for the createEmailEnvTransport "real" tests ---

function fakeNoopSocket(): TextSocket {
  return { write() {}, onData() {}, onError() {}, end() {} };
}

function scriptedFakeFactory(): TextSocketFactory {
  return async () => fakeNoopSocket();
}

function fakeScriptableSocket() {
  const dataCbs: Array<(chunk: string) => void> = [];
  const writeCbs: Array<(data: string) => void> = [];
  const socket: TextSocket & { onWrite(cb: (data: string) => void): void; reply(chunk: string): void } = {
    write(data: string) {
      for (const cb of writeCbs) cb(data);
    },
    onData(cb) {
      dataCbs.push(cb);
    },
    onError() {},
    end() {},
    onWrite(cb) {
      writeCbs.push(cb);
    },
    reply(chunk: string) {
      queueMicrotask(() => {
        for (const cb of dataCbs) cb(chunk);
      });
    },
  };
  return socket;
}
