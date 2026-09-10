/**
 * Dependency-free RFC5322 / MIME handling for the email connector.
 *
 * Every function here is pure (no I/O, no sockets, no clock reads besides the
 * `date` the caller passes in) so the whole MIME layer is testable with plain
 * strings. `parseMessage`/`buildMessage` are the two directions of the same
 * wire format; the rest are the primitives they're built from, exported so
 * tests (and the connector) can exercise header decoding, quoted-printable,
 * base64 and multipart walking in isolation.
 */
import type { EmailAddress, EmailEnvelope, OutgoingEmail } from "./email";

/** The result of parsing a raw RFC5322 message — an {@link EmailEnvelope} minus the IMAP `uid` (that's assigned by the transport). */
export type ParsedEmail = Omit<EmailEnvelope, "uid">;

/** Lowercase-keyed, already-unfolded header values. What {@link extractTextPart} takes so it can be tested without a full message. */
export type EmailHeaders = Record<string, string>;

export interface BuildMessageOptions {
  from: EmailAddress;
  mail: OutgoingEmail;
  messageId: string;
  date: Date;
}

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

/** Parse a raw RFC5322 message into its normalized envelope shape. */
export function parseMessage(raw: string): ParsedEmail {
  const normalized = normalizeNewlines(raw);
  const sepIdx = normalized.indexOf("\n\n");
  const headerBlock = sepIdx === -1 ? normalized : normalized.slice(0, sepIdx);
  const bodyBlock = sepIdx === -1 ? "" : normalized.slice(sepIdx + 2);
  const headers = parseHeaderLines(headerBlock.split("\n"));

  const messageId = extractMsgId(headers["message-id"]) ?? "";
  const inReplyTo = extractMsgId(headers["in-reply-to"]);
  const references = extractMsgIds(headers["references"]);
  const from = parseAddressList(headers["from"] ?? "")[0] ?? { address: "" };
  const to = parseAddressList(headers["to"] ?? "");
  const subject = decodeEncodedWords(headers["subject"] ?? "");
  const date = parseDateHeader(headers["date"]);
  const text = extractTextPart(headers, bodyBlock);

  return { messageId, inReplyTo, references, from, to, subject, text, date };
}

// ---------------------------------------------------------------------------
// buildMessage
// ---------------------------------------------------------------------------

/** Build a raw RFC5322 message (CRLF line endings) from an outgoing mail. */
export function buildMessage(opts: BuildMessageOptions): string {
  const { from, mail, messageId, date } = opts;

  assertNoHeaderInjection(mail.subject, "Subject");
  assertNoHeaderInjection(from.address, "From address");
  if (from.name) assertNoHeaderInjection(from.name, "From name");
  for (const addr of mail.to) {
    assertNoHeaderInjection(addr.address, "To address");
    if (addr.name) assertNoHeaderInjection(addr.name, "To name");
  }
  // Threading headers are rebuilt from *inbound* mail (attacker-supplied
  // Message-ID/References values), so they get the same injection check as
  // every other header value — defense in depth even though parseMessage's
  // line-based header handling cannot itself yield embedded CR/LF.
  if (mail.inReplyTo) assertNoHeaderInjection(mail.inReplyTo, "In-Reply-To");
  for (const ref of mail.references ?? []) assertNoHeaderInjection(ref, "References entry");

  const headers: string[] = [];
  headers.push(foldHeader("From", formatAddress(from)));
  headers.push(foldHeader("To", mail.to.map(formatAddress).join(", ")));
  headers.push(foldHeader("Subject", encodeHeaderWordsIfNeeded(mail.subject)));
  headers.push(foldHeader("Date", formatRfc5322Date(date)));
  headers.push(foldHeader("Message-ID", messageId));
  if (mail.inReplyTo) headers.push(foldHeader("In-Reply-To", mail.inReplyTo));
  if (mail.references && mail.references.length > 0) {
    headers.push(foldHeader("References", mail.references.join(" ")));
  }
  headers.push(foldHeader("MIME-Version", "1.0"));

  const isAscii = /^[\x00-\x7f]*$/.test(mail.text);
  let body: string;
  if (isAscii) {
    headers.push(foldHeader("Content-Type", "text/plain; charset=us-ascii"));
    headers.push(foldHeader("Content-Transfer-Encoding", "7bit"));
    body = normalizeNewlines(mail.text).split("\n").join("\r\n");
  } else {
    headers.push(foldHeader("Content-Type", "text/plain; charset=utf-8"));
    headers.push(foldHeader("Content-Transfer-Encoding", "quoted-printable"));
    body = encodeQuotedPrintable(mail.text);
  }

  return headers.join("\r\n") + "\r\n\r\n" + body;
}

function assertNoHeaderInjection(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${label} must not contain line breaks (rejected a potential header injection)`);
  }
}

function formatRfc5322Date(date: Date): string {
  // Date#toUTCString already yields "Fri, 24 Jul 2026 00:00:00 GMT"; RFC5322 wants a numeric zone.
  return date.toUTCString().replace(/GMT$/, "+0000");
}

function formatAddress(a: EmailAddress): string {
  if (!a.name) return `<${a.address}>`;
  if (!/^[\x20-\x7e]*$/.test(a.name)) return `${encodeWord(a.name)} <${a.address}>`;
  if (/[",]/.test(a.name)) return `"${a.name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${a.address}>`;
  return `${a.name} <${a.address}>`;
}

/** RFC5322 header folding: wrap on word boundaries so no physical line exceeds ~78 chars. */
function foldHeader(name: string, value: string): string {
  const maxLen = 78;
  const prefix = `${name}: `;
  if (prefix.length + value.length <= maxLen) return prefix + value;

  const words = value.split(" ");
  const lines: string[] = [];
  let current = prefix;
  let isFirstWordOnLine = true;
  for (const w of words) {
    const candidate = isFirstWordOnLine ? current + w : current + " " + w;
    if (candidate.length > maxLen && !isFirstWordOnLine) {
      lines.push(current);
      current = " " + w;
      isFirstWordOnLine = false;
    } else {
      current = candidate;
      isFirstWordOnLine = false;
    }
  }
  lines.push(current);
  return lines.join("\r\n");
}

// ---------------------------------------------------------------------------
// Header parsing / unfolding
// ---------------------------------------------------------------------------

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/** Unfold continuation lines (leading whitespace) and split "Name: value" into a lowercase-keyed map. */
function parseHeaderLines(lines: string[]): EmailHeaders {
  const unfolded: string[] = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += " " + line.trim();
    } else if (line.trim() !== "") {
      unfolded.push(line);
    }
  }
  const map: EmailHeaders = {};
  for (const line of unfolded) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    map[name] = name in map ? `${map[name]}, ${value}` : value;
  }
  return map;
}

function extractMsgId(value?: string): string | undefined {
  if (!value) return undefined;
  const m = /<([^>]*)>/.exec(value);
  if (m) return `<${m[1]}>`;
  const trimmed = value.trim();
  return trimmed ? `<${trimmed}>` : undefined;
}

/** Extract well-formed `<id>` tokens; malformed (unclosed) entries are dropped rather than thrown on. */
function extractMsgIds(value?: string): string[] {
  if (!value) return [];
  const ids: string[] = [];
  const re = /<([^<>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    ids.push(`<${m[1]}>`);
  }
  return ids;
}

function parseDateHeader(value?: string): number | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

// ---------------------------------------------------------------------------
// Address lists
// ---------------------------------------------------------------------------

/** Parse a comma-separated RFC5322 address list, honoring quoted display names (which may contain commas). */
export function parseAddressList(v: string): EmailAddress[] {
  const out: EmailAddress[] = [];
  for (const entry of splitAddressList(v)) {
    const parsed = parseOneAddress(entry);
    if (parsed) out.push(parsed);
  }
  return out;
}

function splitAddressList(v: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  let angleDepth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '"' && v[i - 1] !== "\\") inQuotes = !inQuotes;
    if (!inQuotes) {
      if (c === "<") angleDepth++;
      if (c === ">") angleDepth = Math.max(0, angleDepth - 1);
    }
    if (c === "," && !inQuotes && angleDepth === 0) {
      result.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim()) result.push(current);
  return result;
}

function parseOneAddress(entry: string): EmailAddress | null {
  const s = entry.trim();
  if (!s) return null;
  const angleMatch = /^(.*)<([^<>]+)>\s*$/.exec(s);
  if (angleMatch) {
    let name = angleMatch[1].trim();
    const address = angleMatch[2].trim();
    if (!address) return null;
    if (name.startsWith('"') && name.endsWith('"') && name.length >= 2) {
      name = name.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    name = decodeEncodedWords(name);
    return name ? { name, address } : { address };
  }
  return s ? { address: s } : null;
}

// ---------------------------------------------------------------------------
// Content-Transfer-Encoding decoders
// ---------------------------------------------------------------------------

/** Decode quoted-printable text: soft line breaks (`=` at end of line) are removed, `=XX` are hex byte escapes. */
export function decodeQuotedPrintable(input: string): string {
  const joined = input.replace(/=\r\n/g, "").replace(/=\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function encodeQuotedPrintable(text: string): string {
  const lines = normalizeNewlines(text).split("\n");
  return lines.map(encodeQuotedPrintableLine).join("\r\n");
}

function encodeQuotedPrintableLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  let out = "";
  let lineLen = 0;
  const push = (chunk: string) => {
    if (lineLen + chunk.length > 75) {
      out += "=\r\n";
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    const isTrailing = i === bytes.length - 1 && (b === 0x20 || b === 0x09);
    if (b === 0x3d || b < 0x20 || b > 0x7e || isTrailing) {
      push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`);
    } else {
      push(String.fromCharCode(b));
    }
  }
  return out;
}

/** Decode a base64 body (any embedded whitespace/newlines are stripped first) as UTF-8 text. */
export function decodeBase64Text(input: string): string {
  const cleaned = input.replace(/[^A-Za-z0-9+/=]/g, "");
  return Buffer.from(cleaned, "base64").toString("utf8");
}

/** Decode RFC2047 encoded-words (`=?charset?B/Q?...?=`) in header values such as Subject/From. */
export function decodeEncodedWords(input: string): string {
  if (!input || input.indexOf("=?") === -1) return input;
  // Adjacent encoded-words separated only by folding whitespace are logically concatenated (RFC2047 §2).
  const collapsed = input.replace(
    /(=\?[^?\s]+\?[BbQq]\?[^?]*\?=)[ \t]+(?==\?[^?\s]+\?[BbQq]\?[^?]*\?=)/g,
    "$1"
  );
  return collapsed.replace(
    /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g,
    (_match: string, charset: string, enc: string, text: string) => {
      const bytes = enc.toUpperCase() === "B" ? decodeBWordToBytes(text) : decodeQWordToBytes(text);
      return decodeBytesForCharset(bytes, charset);
    }
  );
}

function decodeQWordToBytes(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "_") {
      bytes.push(0x20);
    } else if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeBWordToBytes(text: string): Uint8Array {
  return Uint8Array.from(Buffer.from(text, "base64"));
}

function decodeBytesForCharset(bytes: Uint8Array, charset: string): string {
  const normalized = normalizeCharsetName(charset);
  try {
    return new TextDecoder(normalized).decode(bytes);
  } catch {
    try {
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return Buffer.from(bytes).toString("latin1");
    }
  }
}

function normalizeCharsetName(cs: string): string {
  const c = cs.trim().toLowerCase();
  return c === "us-ascii" || c === "ascii" || c === "" ? "utf-8" : c;
}

/** Encode a header value (e.g. Subject) as RFC2047 encoded-words iff it isn't plain printable ASCII. */
function encodeHeaderWordsIfNeeded(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return chunkEncodeWord(value);
}

function chunkEncodeWord(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  const chunkSize = 45; // keeps each encoded-word comfortably inside the 75-char RFC2047 limit
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(`=?UTF-8?B?${bytes.subarray(i, i + chunkSize).toString("base64")}?=`);
  }
  return chunks.join(" ");
}

function encodeWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

// ---------------------------------------------------------------------------
// Body extraction (multipart walking)
// ---------------------------------------------------------------------------

/** Pull the best plain-text body out of a (possibly multipart) message given its top-level headers and raw body. */
export function extractTextPart(headers: EmailHeaders, body: string): string {
  return extractFromPart(headers, body) ?? "";
}

function extractFromPart(headers: EmailHeaders, body: string): string | undefined {
  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();

  if (contentType.startsWith("multipart/")) {
    const boundary = getBoundary(headers["content-type"] ?? "");
    if (!boundary) return decodeBodyPart(headers, body);
    const parts = splitByBoundary(body, boundary);

    if (contentType.startsWith("multipart/alternative")) {
      for (const p of parts) {
        const pct = (p.headers["content-type"] ?? "text/plain").toLowerCase();
        if (pct.startsWith("text/plain")) return decodeBodyPart(p.headers, p.body);
      }
      for (const p of parts) {
        const pct = (p.headers["content-type"] ?? "text/plain").toLowerCase();
        if (pct.startsWith("multipart/")) {
          const nested = extractFromPart(p.headers, p.body);
          if (nested !== undefined) return nested;
        }
      }
      for (const p of parts) {
        const pct = (p.headers["content-type"] ?? "text/plain").toLowerCase();
        if (pct.startsWith("text/html")) return decodeBodyPart(p.headers, p.body);
      }
      return undefined;
    }

    // multipart/mixed, multipart/related, or anything else: walk in order, skip attachments.
    for (const p of parts) {
      const disposition = (p.headers["content-disposition"] ?? "").toLowerCase();
      if (disposition.startsWith("attachment")) continue;
      const pct = (p.headers["content-type"] ?? "text/plain").toLowerCase();
      if (pct.startsWith("text/") || pct.startsWith("multipart/")) {
        const val = extractFromPart(p.headers, p.body);
        if (val !== undefined && val.trim() !== "") return val;
      }
    }
    return undefined;
  }

  return decodeBodyPart(headers, body);
}

function decodeBodyPart(headers: EmailHeaders, body: string): string {
  const cte = (headers["content-transfer-encoding"] ?? "7bit").toLowerCase();
  let decoded: string;
  if (cte === "base64") decoded = decodeBase64Text(body);
  else if (cte === "quoted-printable") decoded = decodeQuotedPrintable(body);
  else decoded = body;

  const contentType = (headers["content-type"] ?? "text/plain").toLowerCase();
  if (contentType.startsWith("text/html")) decoded = stripHtmlTags(decoded);
  return decoded.replace(/[ \t]*$/, "").replace(/\n+$/, "");
}

function getBoundary(contentType: string): string | undefined {
  const m = /boundary\s*=\s*"([^"]+)"|boundary\s*=\s*([^\s;]+)/i.exec(contentType);
  if (!m) return undefined;
  return m[1] ?? m[2];
}

interface MimePart {
  headers: EmailHeaders;
  body: string;
}

function splitByBoundary(body: string, boundary: string): MimePart[] {
  const marker = `--${boundary}`;
  const endMarker = `${marker}--`;
  const lines = normalizeNewlines(body).split("\n");
  const parts: string[] = [];
  let current: string[] = [];
  let inPart = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === endMarker) {
      if (inPart) parts.push(current.join("\n"));
      break;
    }
    if (trimmed === marker) {
      if (inPart) parts.push(current.join("\n"));
      current = [];
      inPart = true;
      continue;
    }
    if (inPart) current.push(line);
  }
  return parts.map((raw) => {
    const rawLines = raw.split("\n");
    let sep = rawLines.findIndex((l) => l.trim() === "");
    if (sep === -1) sep = rawLines.length;
    return {
      headers: parseHeaderLines(rawLines.slice(0, sep)),
      body: rawLines.slice(sep + 1).join("\n"),
    };
  });
}

function stripHtmlTags(html: string): string {
  const withoutTags = html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtmlEntities(withoutTags).replace(/\n{3,}/g, "\n\n").trim();
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}
