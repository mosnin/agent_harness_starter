/**
 * Real behavioral tests for `extract.ts`: pure HTML -> cited-passage
 * extraction. Every fixture here is a literal HTML/text string run
 * through the real tokenizer — nothing is mocked. `assertPassageInvariants`
 * independently recomputes each passage's sha256 with a fresh
 * `node:crypto` hash (not the module's internal helper) so it genuinely
 * exercises the "verifier recomputes instead of trusting" property.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  extractFromHtml,
  extractFromPage,
  type ExtractResult,
  type ExtractablePage,
} from "../extract";

function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function assertPassageInvariants(
  result: ExtractResult,
  opts: { maxPassages: number; minPassageChars: number; url: string }
): void {
  expect(result.passages.length).toBeLessThanOrEqual(opts.maxPassages);
  let lastIndex = -1;
  for (const p of result.passages) {
    expect(p.text.length).toBeGreaterThanOrEqual(opts.minPassageChars);
    expect(p.sourceUrl).toBe(opts.url);
    expect(p.index).toBeGreaterThan(lastIndex);
    lastIndex = p.index;
    expect(p.sha256).toBe(sha256Of(p.text));
    expect(p.selectorPath.length).toBeGreaterThan(0);
  }
}

const URL1 = "https://example.com/articles/foo";

// ===========================================================================
// Basic HTML extraction, title, contentType
// ===========================================================================

describe("extractFromHtml — basic HTML extraction", () => {
  it("extracts title, block passages, and reports contentType html", () => {
    const html = `<html><body><main>
      <h1>Welcome to the Article</h1>
      <p>This is the first paragraph of real content, long enough to clear the default forty character minimum.</p>
      <p>This is the second paragraph, also comfortably longer than forty characters so it becomes a passage.</p>
    </main></body></html>`;
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.contentType).toBe("html");
    expect(result.url).toBe(URL1);
    expect(result.passages.length).toBe(2);
    expect(result.passages[0].text).toContain("first paragraph");
    expect(result.passages[1].text).toContain("second paragraph");
    assertPassageInvariants(result, { maxPassages: 64, minPassageChars: 40, url: URL1 });
  });

  it("collapses whitespace and inserts newline boundaries only at block edges, not inline ones", () => {
    const html = `<div><b>Bold text that keeps <i>going and going</b> even past italic close and still continues on for a while longer here.</i></div>`;
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toBe(
      "Bold text that keeps going and going even past italic close and still continues on for a while longer here."
    );
    expect(result.passages[0].selectorPath).toBe("div");
  });

  it("returns empty title, empty passages, contentType html but no crash on empty body", () => {
    const result = extractFromHtml("<html><head></head><body></body></html>", { url: URL1 });
    expect(result.title).toBe("");
    expect(result.passages).toEqual([]);
    expect(result.text).toBe("");
    expect(result.contentType).toBe("html");
  });
});

// ===========================================================================
// Plain-text mode
// ===========================================================================

describe("extractFromHtml — plain text mode", () => {
  it("treats tag-free input as contentType text, split into paragraph passages", () => {
    const input =
      "First plain paragraph of the document, long enough to pass the forty character minimum easily.\n\n" +
      "Second plain paragraph, also comfortably over the forty character minimum threshold for citation.\n\n" +
      "x";
    const result = extractFromHtml(input, { url: URL1 });
    expect(result.contentType).toBe("text");
    expect(result.title).toBe("");
    expect(result.links).toEqual([]);
    expect(result.meta).toEqual({});
    expect(result.passages.length).toBe(2);
    expect(result.passages[0].selectorPath).toBe("text>p:nth-of-type(1)");
    expect(result.passages[1].selectorPath).toBe("text>p:nth-of-type(2)");
    assertPassageInvariants(result, { maxPassages: 64, minPassageChars: 40, url: URL1 });
  });

  it("does not misclassify a heart-emoticon-bearing string as HTML", () => {
    const result = extractFromHtml("i <3 u, this plain text has no real markup at all in it whatsoever.", {
      url: URL1,
    });
    expect(result.contentType).toBe("text");
  });
});

// ===========================================================================
// Entity decoding
// ===========================================================================

describe("extractFromHtml — entity decoding", () => {
  it("decodes named entities amp/lt/gt/quot/apos/nbsp", () => {
    const html =
      "<div>A &amp; B &lt;tag&gt; &quot;quoted&quot; &apos;single&apos; non&nbsp;breaking space here padding text.</div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages[0].text).toBe(
      'A & B <tag> "quoted" \'single\' non breaking space here padding text.'
    );
  });

  it("decodes decimal and hex numeric entities", () => {
    const html = "<div>Letter A is &#65; and letter A in hex is &#x41; padded out for length here now.</div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages[0].text).toContain("Letter A is A and letter A in hex is A padded");
  });

  it("keeps double-encoded entities single-decoded, never re-decoded", () => {
    const html = "<div>The company is called AT&amp;amp;T Corp, padded with extra filler words for length.</div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages[0].text).toContain("AT&amp;T Corp");
    expect(result.passages[0].text).not.toContain("AT&T Corp");
    expect(result.passages[0].text).not.toContain("AT&amp;amp;T Corp");
  });

  it("passes unterminated / unknown entities through literally without crashing", () => {
    const html = "<div>Fish &amp chips and a stray &bogus; entity plus &notreal here padded for length now.</div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(() => result.passages[0].text).not.toThrow();
    expect(result.passages[0].text).toContain("&amp chips");
    expect(result.passages[0].text).toContain("&bogus;");
    expect(result.passages[0].text).toContain("&notreal");
  });

  it("replaces out-of-range / overflow numeric entities safely, never crashing", () => {
    const html = "<div>Overflow entity &#99999999; and huge hex &#xFFFFFFFF; stay literal here, padded now.</div>";
    expect(() => extractFromHtml(html, { url: URL1 })).not.toThrow();
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages[0].text).toContain("&#99999999;");
    expect(result.passages[0].text).toContain("&#xFFFFFFFF;");
  });
});

// ===========================================================================
// Tolerant / adversarial parsing
// ===========================================================================

describe("extractFromHtml — tolerant adversarial parsing", () => {
  it("auto-closes unclosed <p> soup into separate passages", () => {
    const html =
      "<p>Alpha paragraph with enough characters to pass the minimum length threshold easily here now." +
      "<p>Beta paragraph also long enough to pass the minimum length threshold with room to spare here." +
      "<p>Gamma paragraph long enough too, exceeding the minimum character threshold nicely once again.";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages.length).toBe(3);
    expect(result.passages[0].text).toContain("Alpha paragraph");
    expect(result.passages[1].text).toContain("Beta paragraph");
    expect(result.passages[2].text).toContain("Gamma paragraph");
  });

  it("handles attribute quoting with double, single, and unquoted values without crashing", () => {
    const html =
      `<div data-a="double" data-b='single' data-c=unquoted class="test">` +
      `Attr quoting variety paragraph with enough characters to clear the minimum length threshold here.</div>`;
    expect(() => extractFromHtml(html, { url: URL1 })).not.toThrow();
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages[0].text).toContain("Attr quoting variety paragraph");
  });

  it("treats comments as opaque, never parsing fake tags hidden inside them", () => {
    const html =
      "<div><!-- <script>alert(1)</script> --><p>Real paragraph after a comment containing fake tags, long enough to pass the threshold easily.</p></div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.text).not.toContain("alert(1)");
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toContain("Real paragraph after a comment");
  });

  it("skips CDATA-ish junk without parsing it as markup", () => {
    const html =
      "<div><![CDATA[ some <fake> junk that should never appear ]]><p>Paragraph following CDATA junk, long enough to pass the minimum character threshold comfortably.</p></div>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.text).not.toContain("fake");
    expect(result.text).not.toContain("should never appear");
    expect(result.passages[0].text).toContain("Paragraph following CDATA junk");
  });

  it("is case-insensitive to uppercase and mixed-case tag names", () => {
    const html =
      "<DIV><P>Mixed CASE Tag Names paragraph with enough characters to clear the minimum length threshold nicely here.</P></DIV>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].selectorPath).toBe("div>p");
    expect(result.passages[0].text).toContain("Mixed CASE Tag Names");
  });

  it("never throws on a stray unterminated tag opener", () => {
    const html = "<div>Some text <  and more text after a stray angle bracket, padded out for length here now.</div>";
    expect(() => extractFromHtml(html, { url: URL1 })).not.toThrow();
  });

  it("auto-closes an unclosed <title> instead of swallowing the rest of the document", () => {
    const html =
      "<html><head><title>Runaway Title<body><p>This body paragraph must still be extracted normally and not be absorbed into the title text at all.</p></body></html>";
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.title).toBe("Runaway Title");
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toContain("This body paragraph must still be extracted");
  });

  it("strips script/style/noscript/template/iframe/svg content entirely", () => {
    const html = `<html><body>
      <script>var secretScript = "should not appear";</script>
      <style>.secretStyle { color: red; }</style>
      <noscript>secretNoscript content here</noscript>
      <template><p>secretTemplate content here</p></template>
      <iframe src="x">secretIframe content here</iframe>
      <svg><text>secretSvg content here</text></svg>
      <p>Visible paragraph that must survive extraction, long enough to pass the minimum length threshold.</p>
    </body></html>`;
    const result = extractFromHtml(html, { url: URL1 });
    for (const bad of ["secretScript", "secretStyle", "secretNoscript", "secretTemplate", "secretIframe", "secretSvg"]) {
      expect(result.text).not.toContain(bad);
    }
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toContain("Visible paragraph");
  });

  it("does not hang or blow up on a document stuffed with thousands of ampersands", () => {
    const stuffed = "<div>" + "&amp;".repeat(20000) + " padded tail text to keep this from being trivial.</div>";
    expect(() => extractFromHtml(stuffed, { url: URL1 })).not.toThrow();
  });
});

// ===========================================================================
// selectorPath — nested fixture matching the contract's illustrative example
// ===========================================================================

describe("extractFromHtml — selectorPath disambiguation", () => {
  it("computes html>body>main>p:nth-of-type(2) for the second of two sibling <p>s, no suffix for singleton ancestors", () => {
    const html = `<html><body><main>
<p>First paragraph with enough characters to pass the minimum threshold for citation purposes here.</p>
<div><p>Nested paragraph inside a div, also long enough to become a cited passage in this fixture.</p></div>
<p>Second top-level paragraph under main, likewise long enough to be cited as well in this fixture.</p>
</main></body></html>`;
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.passages.length).toBe(3);
    expect(result.passages[0].selectorPath).toBe("html>body>main>p:nth-of-type(1)");
    expect(result.passages[0].text).toContain("First paragraph");
    expect(result.passages[1].selectorPath).toBe("html>body>main>div>p");
    expect(result.passages[1].text).toContain("Nested paragraph");
    expect(result.passages[2].selectorPath).toBe("html>body>main>p:nth-of-type(2)");
    expect(result.passages[2].text).toContain("Second top-level paragraph");
    assertPassageInvariants(result, { maxPassages: 64, minPassageChars: 40, url: URL1 });
  });
});

// ===========================================================================
// Links, <base href>, meta extraction
// ===========================================================================

describe("extractFromHtml — links, base href resolution, meta", () => {
  const html = `<!DOCTYPE html>
<html lang="en-US">
<head>
<title>  My   Page  Title </title>
<base href="https://cdn.example.com/assets/">
<meta charset="utf-8">
<meta name="description" content="Widgets &amp; Gadgets, made simple.">
<link rel="canonical" href="/canonical-path?x=1">
</head>
<body>
<main>
<p>Paragraph with a <a href="../sibling/page.html">relative link</a> and more text to pass the min length threshold.</p>
<p>Another paragraph with a <a href='https://external.example.org/foo?q=bar#frag'>quoted single href link</a> plus filler text.</p>
<p><a href="//other.example.com/path">protocol relative link</a> another chunk of filler text so this passage clears the minimum.</p>
<p><a href="#just-a-fragment">fragment only link</a> filler filler filler filler filler filler to reach the length minimum.</p>
<p><a href="javascript:alert(1)">js link excluded</a> and <a href="data:text/plain;base64,aGk=">data link excluded</a> plus padding here.</p>
<p><a href="   ">blank href excluded</a> plus enough padding filler text here so this passage is long enough too now.</p>
<p><a>no href at all here</a> plus enough padding filler text here so this passage is long enough too as well yes.</p>
<p><a href="http://[not-valid">malformed href excluded</a> plus enough padding filler text here to clear the length floor.</p>
</main>
</body>
</html>`;

  it("extracts title, lang, description, and a base-resolved absolute canonical URL", () => {
    const result = extractFromHtml(html, { url: URL1 });
    expect(result.title).toBe("My Page Title");
    expect(result.meta.lang).toBe("en-US");
    expect(result.meta.description).toBe("Widgets & Gadgets, made simple.");
    expect(result.meta.canonical).toBe("https://cdn.example.com/canonical-path?x=1");
  });

  it("resolves relative, ../ traversal, protocol-relative, and fragment-only hrefs against <base href>, excluding javascript:/data:/blank/missing/malformed", () => {
    const result = extractFromHtml(html, { url: URL1 });
    const hrefs = result.links.map((l) => l.href);
    expect(hrefs).toEqual([
      "https://cdn.example.com/sibling/page.html",
      "https://external.example.org/foo?q=bar#frag",
      "https://other.example.com/path",
      "https://cdn.example.com/assets/#just-a-fragment",
    ]);
    expect(result.links[0].text).toBe("relative link");
    for (const excluded of ["javascript:", "data:", "[not-valid"]) {
      expect(hrefs.some((h) => h.includes(excluded))).toBe(false);
    }
  });

  it("never throws on a malformed href", () => {
    expect(() => extractFromHtml(html, { url: URL1 })).not.toThrow();
  });

  it("reports empty meta fields honestly when absent, no fabrication", () => {
    const bare = extractFromHtml("<html><body><p>Nothing but a plain paragraph here, long enough to clear the minimum length floor easily.</p></body></html>", {
      url: URL1,
    });
    expect(bare.meta.description).toBeUndefined();
    expect(bare.meta.lang).toBeUndefined();
    expect(bare.meta.canonical).toBeUndefined();
  });
});

// ===========================================================================
// Options: maxBytes, maxPassages, minPassageChars, maxLinks
// ===========================================================================

describe("extractFromHtml — options respected", () => {
  function makeManyParagraphs(count: number, wordsPerParagraph = 20): string {
    const parts: string[] = [];
    for (let k = 0; k < count; k++) {
      const words = Array.from({ length: wordsPerParagraph }, (_, w) => `word${k}_${w}`).join(" ");
      parts.push(`<p>${words}</p>`);
    }
    return `<html><body><main>${parts.join("")}</main></body></html>`;
  }

  it("caps passages at maxPassages while text and bytes remain honest", () => {
    const html = makeManyParagraphs(10);
    const result = extractFromHtml(html, { url: URL1, maxPassages: 3 });
    expect(result.passages.length).toBe(3);
    assertPassageInvariants(result, { maxPassages: 3, minPassageChars: 40, url: URL1 });
  });

  it("respects a custom minPassageChars, excluding short runs from passages but not from text", () => {
    const html = "<html><body><div>short</div><div>this one is definitely long enough to pass a small threshold</div></body></html>";
    const result = extractFromHtml(html, { url: URL1, minPassageChars: 10 });
    expect(result.text).toContain("short");
    expect(result.passages.length).toBe(1);
    expect(result.passages[0].text).toContain("definitely long enough");
  });

  it("truncates text honestly at maxBytes and reports pre-truncation bytes", () => {
    const html = makeManyParagraphs(50, 30);
    const full = extractFromHtml(html, { url: URL1, maxBytes: 1_000_000 });
    expect(full.truncated).toBe(false);
    const small = extractFromHtml(html, { url: URL1, maxBytes: 200 });
    expect(small.truncated).toBe(true);
    expect(small.bytes).toBe(full.bytes);
    expect(Buffer.byteLength(small.text, "utf8")).toBeLessThanOrEqual(200);
    expect(small.bytes).toBeGreaterThan(200);
    assertPassageInvariants(small, { maxPassages: 64, minPassageChars: 40, url: URL1 });
  });

  it("caps links at maxLinks in document order", () => {
    const anchors = Array.from({ length: 10 }, (_, k) => `<a href="/page${k}">link ${k}</a>`).join(" ");
    const html = `<html><body><p>${anchors}</p></body></html>`;
    const result = extractFromHtml(html, { url: URL1, maxLinks: 3 });
    expect(result.links.length).toBe(3);
    expect(result.links.map((l) => l.text)).toEqual(["link 0", "link 1", "link 2"]);
  });
});

// ===========================================================================
// Determinism
// ===========================================================================

describe("extractFromHtml — determinism", () => {
  it("produces byte-identical output across repeated calls on the same input", () => {
    const html = `<html lang="en"><head><title>Determinism</title><meta name="description" content="stable"></head>
      <body><main><p>Deterministic paragraph number one, long enough to be cited as a passage here.</p>
      <p>Deterministic paragraph number two, also long enough to be cited as a passage here.</p></main></body></html>`;
    const a = extractFromHtml(html, { url: URL1 });
    const b = extractFromHtml(html, { url: URL1 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ===========================================================================
// Large input (~5MB), single-pass performance and honest truncation
// ===========================================================================

describe("extractFromHtml — large input handling", () => {
  it("processes a multi-megabyte document within the byte budget without crashing, truncating honestly", () => {
    const parts: string[] = [];
    for (let k = 0; k < 40000; k++) {
      parts.push(
        `<p>Paragraph number ${k} contains enough filler text to exceed the forty character minimum threshold comfortably every single time it repeats.</p>`
      );
    }
    const bigHtml = `<html><body><main>${parts.join("")}</main></body></html>`;
    expect(bigHtml.length).toBeGreaterThanOrEqual(5_000_000);

    const result = extractFromHtml(bigHtml, { url: URL1 });
    expect(result.contentType).toBe("html");
    expect(result.truncated).toBe(true);
    expect(result.bytes).toBeGreaterThan(200_000);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(200_000);
    assertPassageInvariants(result, { maxPassages: 64, minPassageChars: 40, url: URL1 });
  });
});

// ===========================================================================
// extractFromPage — ExtractablePage seam
// ===========================================================================

function makePage(url: string, title: string, html: string): ExtractablePage {
  return {
    url: () => url,
    title: async () => title,
    html: async () => html,
  };
}

describe("extractFromPage", () => {
  const html = `<html><head><title>HTML Title</title></head><body>
    <p>Body paragraph long enough to be cited as a real passage in this fixture for the test.</p>
  </body></html>`;

  it("prefers a non-empty page.title() over the document's <title>", () => {
    return extractFromPage(makePage(URL1, "Driver Title", html)).then((result) => {
      expect(result.title).toBe("Driver Title");
      expect(result.url).toBe(URL1);
      expect(result.passages.length).toBe(1);
    });
  });

  it("falls back to the document <title> when page.title() is empty", () => {
    return extractFromPage(makePage(URL1, "", html)).then((result) => {
      expect(result.title).toBe("HTML Title");
    });
  });

  it("falls back to the document <title> when page.title() is only whitespace", () => {
    return extractFromPage(makePage(URL1, "   ", html)).then((result) => {
      expect(result.title).toBe("HTML Title");
    });
  });

  it("passes options through to the underlying extractFromHtml call", () => {
    return extractFromPage(makePage(URL1, "T", html), { minPassageChars: 1000 }).then((result) => {
      expect(result.passages).toEqual([]);
    });
  });

  it("matches extractFromHtml exactly aside from the title override", () => {
    return extractFromPage(makePage(URL1, "", html)).then((viaPage) => {
      const direct = extractFromHtml(html, { url: URL1 });
      expect(viaPage.text).toBe(direct.text);
      expect(viaPage.passages).toEqual(direct.passages);
      expect(viaPage.links).toEqual(direct.links);
      expect(viaPage.meta).toEqual(direct.meta);
    });
  });
});
