import { describe, it, expect } from "vitest";
import {
  parseMessage,
  buildMessage,
  parseAddressList,
  decodeQuotedPrintable,
  decodeBase64Text,
  decodeEncodedWords,
  extractTextPart,
} from "../gateway/connectors/email-mime";

describe("email-mime: header parsing / unfolding", () => {
  it("unfolds multi-line headers before extracting values", () => {
    const raw =
      "Subject: This is a very long subject\r\n" +
      " that continues on a folded line\r\n" +
      "From: Alice <alice@example.com>\r\n" +
      "To: bob@example.com\r\n" +
      "Message-ID: <m1@example.com>\r\n" +
      "\r\n" +
      "hi";
    const parsed = parseMessage(raw);
    expect(parsed.subject).toBe("This is a very long subject that continues on a folded line");
    expect(parsed.from).toEqual({ name: "Alice", address: "alice@example.com" });
  });

  it("extracts Message-ID, In-Reply-To, References and converts Date to ms", () => {
    const raw =
      "Message-ID: <child@x.com>\r\n" +
      "In-Reply-To: <parent@x.com>\r\n" +
      "References: <root@x.com> <mid@x.com> <parent@x.com>\r\n" +
      "Date: Fri, 24 Jul 2026 12:00:00 +0000\r\n" +
      "From: a@x.com\r\n" +
      "To: b@x.com\r\n" +
      "Subject: hi\r\n" +
      "\r\n" +
      "body text";
    const parsed = parseMessage(raw);
    expect(parsed.messageId).toBe("<child@x.com>");
    expect(parsed.inReplyTo).toBe("<parent@x.com>");
    expect(parsed.references).toEqual(["<root@x.com>", "<mid@x.com>", "<parent@x.com>"]);
    expect(parsed.date).toBe(Date.parse("Fri, 24 Jul 2026 12:00:00 +0000"));
    expect(parsed.text).toBe("body text");
  });

  it("tolerates a missing Date header (date is undefined, no throw)", () => {
    const raw = "From: a@x.com\r\nTo: b@x.com\r\nSubject: hi\r\nMessage-ID: <m@x.com>\r\n\r\nbody";
    const parsed = parseMessage(raw);
    expect(parsed.date).toBeUndefined();
  });

  it("gracefully drops malformed References entries instead of throwing", () => {
    const raw =
      "Message-ID: <m@x.com>\r\n" +
      "References: <a@x <b@x.com> garbage <c@x.com>\r\n" +
      "From: a@x.com\r\nTo: b@x.com\r\nSubject: hi\r\n\r\nbody";
    expect(() => parseMessage(raw)).not.toThrow();
    const parsed = parseMessage(raw);
    expect(parsed.references).toEqual(["<b@x.com>", "<c@x.com>"]);
  });
});

describe("email-mime: encoded words (RFC2047)", () => {
  it("decodes a B-encoded (base64) UTF-8 subject", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("héllo wörld", "utf8").toString("base64")}?=`;
    expect(decodeEncodedWords(encoded)).toBe("héllo wörld");
  });

  it("decodes a Q-encoded UTF-8 subject with underscores as spaces", () => {
    // "Caf=C3=A9 time" utf-8-encoded, spaces as underscores
    const encoded = "=?UTF-8?Q?Caf=C3=A9_time?=";
    expect(decodeEncodedWords(encoded)).toBe("Café time");
  });

  it("decodes a B-encoded latin1 (iso-8859-1) subject", () => {
    const latin1Bytes = Buffer.from([0x43, 0x61, 0x66, 0xe9]); // "Café" in latin1
    const encoded = `=?ISO-8859-1?B?${latin1Bytes.toString("base64")}?=`;
    expect(decodeEncodedWords(encoded)).toBe("Café");
  });

  it("decodes a Q-encoded latin1 subject", () => {
    const encoded = "=?ISO-8859-1?Q?Caf=E9?=";
    expect(decodeEncodedWords(encoded)).toBe("Café");
  });

  it("joins adjacent encoded-words separated only by folding whitespace, and leaves plain text alone", () => {
    const encoded = "Re: =?UTF-8?B?aGVsbG8=?= =?UTF-8?B?d29ybGQ=?= plain suffix";
    expect(decodeEncodedWords(encoded)).toBe("Re: helloworld plain suffix");
  });

  it("passes through subjects with no encoded words unchanged", () => {
    expect(decodeEncodedWords("Plain ASCII subject")).toBe("Plain ASCII subject");
  });
});

describe("email-mime: quoted-printable / base64 decoders", () => {
  it("decodes soft line breaks (the =CRLF marker itself contributes no character) and =XX hex escapes", () => {
    const qp = "This is a long line that soft-wraps =\r\nright here, and has an =C3=A9 escape.";
    expect(decodeQuotedPrintable(qp)).toBe("This is a long line that soft-wraps right here, and has an é escape.");
  });

  it("decodes a bare LF soft break too", () => {
    const qp = "abc=\ndef";
    expect(decodeQuotedPrintable(qp)).toBe("abcdef");
  });

  it("decodes base64 bodies to UTF-8 text", () => {
    const encoded = Buffer.from("multi\nline\nbody with é", "utf8").toString("base64");
    expect(decodeBase64Text(encoded)).toBe("multi\nline\nbody with é");
  });

  it("decodeBase64Text tolerates embedded newlines/whitespace in the base64 payload", () => {
    const raw = Buffer.from("hello world", "utf8").toString("base64");
    const wrapped = raw.slice(0, 4) + "\r\n" + raw.slice(4);
    expect(decodeBase64Text(wrapped)).toBe("hello world");
  });
});

describe("email-mime: extractTextPart / multipart walking", () => {
  it("prefers text/plain in multipart/alternative", () => {
    const boundary = "BOUND1";
    const body =
      `--${boundary}\r\n` +
      "Content-Type: text/plain\r\n\r\n" +
      "plain body\r\n" +
      `--${boundary}\r\n` +
      "Content-Type: text/html\r\n\r\n" +
      "<p>html body</p>\r\n" +
      `--${boundary}--\r\n`;
    const headers = { "content-type": `multipart/alternative; boundary="${boundary}"` };
    expect(extractTextPart(headers, body)).toBe("plain body");
  });

  it("falls back to a tag-stripped text/html part when there is no text/plain alternative", () => {
    const boundary = "BOUND2";
    const body =
      `--${boundary}\r\n` +
      "Content-Type: text/html\r\n\r\n" +
      "<p>Hello <b>world</b></p><br>Line two\r\n" +
      `--${boundary}--\r\n`;
    const headers = { "content-type": `multipart/alternative; boundary="${boundary}"` };
    const text = extractTextPart(headers, body);
    expect(text).toContain("Hello world");
    expect(text).toContain("Line two");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<b>");
  });

  it("walks nested multipart/mixed containing a multipart/alternative part plus an attachment", () => {
    const innerBoundary = "INNER";
    const outerBoundary = "OUTER";
    const innerBody =
      `--${innerBoundary}\r\n` +
      "Content-Type: text/plain\r\n\r\n" +
      "the real message\r\n" +
      `--${innerBoundary}\r\n` +
      "Content-Type: text/html\r\n\r\n" +
      "<p>the real message</p>\r\n" +
      `--${innerBoundary}--\r\n`;
    const outerBody =
      `--${outerBoundary}\r\n` +
      `Content-Type: multipart/alternative; boundary="${innerBoundary}"\r\n\r\n` +
      innerBody +
      `\r\n--${outerBoundary}\r\n` +
      "Content-Type: application/pdf\r\n" +
      "Content-Disposition: attachment; filename=doc.pdf\r\n" +
      "Content-Transfer-Encoding: base64\r\n\r\n" +
      Buffer.from("not text").toString("base64") +
      `\r\n--${outerBoundary}--\r\n`;
    const headers = { "content-type": `multipart/mixed; boundary="${outerBoundary}"` };
    expect(extractTextPart(headers, outerBody)).toBe("the real message");
  });

  it("decodes quoted-printable and base64 encoded body parts", () => {
    const qpHeaders = { "content-type": "text/plain", "content-transfer-encoding": "quoted-printable" };
    expect(extractTextPart(qpHeaders, "caf=C3=A9")).toBe("café");

    const b64Headers = { "content-type": "text/plain", "content-transfer-encoding": "base64" };
    expect(extractTextPart(b64Headers, Buffer.from("plain body", "utf8").toString("base64"))).toBe("plain body");
  });

  it("returns a plain 7bit body untouched when there's no multipart/encoding at all", () => {
    expect(extractTextPart({}, "just some plain text")).toBe("just some plain text");
  });
});

describe("email-mime: parseAddressList", () => {
  it("parses a comma-separated list with quoted display names containing commas", () => {
    const addrs = parseAddressList('"Doe, Jane" <jane@example.com>, Bob Roe <bob@example.com>');
    expect(addrs).toEqual([
      { name: "Doe, Jane", address: "jane@example.com" },
      { name: "Bob Roe", address: "bob@example.com" },
    ]);
  });

  it("parses bare addresses with no display name", () => {
    expect(parseAddressList("plain@example.com")).toEqual([{ address: "plain@example.com" }]);
  });

  it("decodes encoded-word display names", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("héllo", "utf8").toString("base64")}?= <h@example.com>`;
    expect(parseAddressList(encoded)).toEqual([{ name: "héllo", address: "h@example.com" }]);
  });

  it("returns an empty array for an empty/blank input", () => {
    expect(parseAddressList("")).toEqual([]);
    expect(parseAddressList("   ")).toEqual([]);
  });
});

describe("email-mime: buildMessage / round trip", () => {
  it("builds CRLF-terminated, folded RFC5322 headers", () => {
    const raw = buildMessage({
      from: { name: "Alice", address: "alice@example.com" },
      mail: { to: [{ name: "Bob", address: "bob@example.com" }], subject: "Hello", text: "Hi Bob" },
      messageId: "<m1@example.com>",
      date: new Date("2026-07-24T12:00:00Z"),
    });
    expect(raw).toContain("\r\n");
    const headerBlock = raw.slice(0, raw.indexOf("\r\n\r\n"));
    // No bare LFs anywhere in the header block (every line break is CRLF).
    expect(headerBlock.includes("\n")).toBe(headerBlock.includes("\r\n"));
    expect(/(?<!\r)\n/.test(headerBlock)).toBe(false);
    expect(raw).toContain("From: Alice <alice@example.com>\r\n");
    expect(raw).toContain("To: Bob <bob@example.com>\r\n");
    expect(raw).toContain("Message-ID: <m1@example.com>\r\n");
    expect(raw.endsWith("Hi Bob")).toBe(true);
  });

  it("round-trips headers that matter through parseMessage", () => {
    const opts = {
      from: { name: "Alice", address: "alice@example.com" },
      mail: {
        to: [{ name: "Bob", address: "bob@example.com" }],
        subject: "Round trip subject",
        text: "Plain ascii body",
        inReplyTo: "<parent@example.com>",
        references: ["<root@example.com>", "<parent@example.com>"],
      },
      messageId: "<child@example.com>",
      date: new Date("2026-07-24T12:00:00Z"),
    };
    const raw = buildMessage(opts);
    const parsed = parseMessage(raw);
    expect(parsed.messageId).toBe(opts.messageId);
    expect(parsed.subject).toBe(opts.mail.subject);
    expect(parsed.from).toEqual(opts.from);
    expect(parsed.to).toEqual(opts.mail.to);
    expect(parsed.inReplyTo).toBe(opts.mail.inReplyTo);
    expect(parsed.references).toEqual(opts.mail.references);
    expect(parsed.text).toBe(opts.mail.text);
  });

  it("round-trips a non-ASCII subject and body via quoted-printable / encoded-words", () => {
    const raw = buildMessage({
      from: { address: "a@x.com" },
      mail: { to: [{ address: "b@x.com" }], subject: "Café rendez-vous 🎉", text: "Bonjour, à bientôt — café ☕" },
      messageId: "<m2@x.com>",
      date: new Date("2026-07-24T12:00:00Z"),
    });
    const parsed = parseMessage(raw);
    expect(parsed.subject).toBe("Café rendez-vous 🎉");
    expect(parsed.text).toBe("Bonjour, à bientôt — café ☕");
  });

  it("folds a long subject and reassembles it correctly on parse", () => {
    const longSubject = "word ".repeat(30).trim();
    const raw = buildMessage({
      from: { address: "a@x.com" },
      mail: { to: [{ address: "b@x.com" }], subject: longSubject, text: "body" },
      messageId: "<m3@x.com>",
      date: new Date("2026-07-24T12:00:00Z"),
    });
    // Actually folded across multiple physical lines.
    const subjectBlock = raw.slice(raw.indexOf("Subject:"), raw.indexOf("\r\nDate:"));
    expect(subjectBlock.split("\r\n").length).toBeGreaterThan(1);
    expect(parseMessage(raw).subject).toBe(longSubject);
  });

  it("omits In-Reply-To/References headers when not replying", () => {
    const raw = buildMessage({
      from: { address: "a@x.com" },
      mail: { to: [{ address: "b@x.com" }], subject: "fresh", text: "body" },
      messageId: "<m4@x.com>",
      date: new Date(),
    });
    expect(raw).not.toContain("In-Reply-To:");
    expect(raw).not.toContain("References:");
  });

  it("rejects a subject containing raw CR/LF (header injection attempt)", () => {
    expect(() =>
      buildMessage({
        from: { address: "a@x.com" },
        mail: { to: [{ address: "b@x.com" }], subject: "evil\r\nBcc: attacker@evil.com", text: "body" },
        messageId: "<m5@x.com>",
        date: new Date(),
      })
    ).toThrow();
  });

  it("rejects an address display name containing raw CR/LF", () => {
    expect(() =>
      buildMessage({
        from: { address: "a@x.com" },
        mail: { to: [{ name: "evil\r\nBcc: attacker@evil.com", address: "b@x.com" }], subject: "hi", text: "body" },
        messageId: "<m6@x.com>",
        date: new Date(),
      })
    ).toThrow();
  });
});
