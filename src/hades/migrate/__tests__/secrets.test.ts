import { describe, it, expect } from "vitest";
import { inspect } from "node:util";

import {
  SecretVault,
  parseEnvFile,
  scanShellProfile,
  harvestConfigSecrets,
  classifyProviderKey,
  redactValue,
  looksLikeKeyMaterial,
} from "../secrets";
import type { JsonValue } from "../../state/record";

// ---------------------------------------------------------------------------
// parseEnvFile — real dotenv semantics
// ---------------------------------------------------------------------------

describe("parseEnvFile", () => {
  it("parses export prefix, quoting styles, comments, blanks, and duplicates", () => {
    const text = [
      "# a leading comment",
      "",
      "export ANTHROPIC_API_KEY=sk-ant-api03-abcdef",
      'DOUBLE="hello world"',
      "SINGLE='literal $NOT_INTERPOLATED value'",
      "UNQUOTED=plain value with spaces",
      "TRAILING_COMMENT=value # this is a comment",
      'HASH_IN_QUOTES="value # not a comment"',
      "DUPLICATE=first",
      "DUPLICATE=second",
      "",
    ].join("\n");

    const entries = parseEnvFile(text);
    const byKeyLine = (key: string, line: number) => entries.find((e) => e.key === key && e.line === line);

    expect(byKeyLine("ANTHROPIC_API_KEY", 3)).toEqual({
      key: "ANTHROPIC_API_KEY",
      value: "sk-ant-api03-abcdef",
      line: 3,
      exported: true,
    });
    expect(byKeyLine("DOUBLE", 4)?.value).toBe("hello world");
    expect(byKeyLine("SINGLE", 5)?.value).toBe("literal $NOT_INTERPOLATED value");
    expect(byKeyLine("UNQUOTED", 6)?.value).toBe("plain value with spaces");
    expect(byKeyLine("TRAILING_COMMENT", 7)?.value).toBe("value");
    expect(byKeyLine("HASH_IN_QUOTES", 8)?.value).toBe("value # not a comment");

    const dups = entries.filter((e) => e.key === "DUPLICATE");
    expect(dups.map((d) => d.value)).toEqual(["first", "second"]);
    expect(dups.map((d) => d.line)).toEqual([9, 10]);
  });

  it("never executes or interpolates shell — $VAR and `cmd` stay literal", () => {
    const [entry] = parseEnvFile('FOO="$HOME/${OTHER}/`whoami`"');
    expect(entry.value).toBe("$HOME/${OTHER}/`whoami`");
  });

  it("handles single/double quote escapes: \\n \\t \\\\ \\\" \\$", () => {
    const [entry] = parseEnvFile('KEY="line1\\nline2\\ttabbed\\\\backslash\\"quoted\\$dollar"');
    expect(entry.value).toBe('line1\nline2\ttabbed\\backslash"quoted$dollar');
  });

  it("single-quoted values apply no escape processing at all", () => {
    const [entry] = parseEnvFile("KEY='raw \\n stays literal backslash-n'");
    expect(entry.value).toBe("raw \\n stays literal backslash-n");
  });

  it("supports multi-line double- and single-quoted values", () => {
    const text = 'MULTI="line one\nline two\nline three"\nAFTER=ok';
    const entries = parseEnvFile(text);
    expect(entries[0]).toEqual({ key: "MULTI", value: "line one\nline two\nline three", line: 1, exported: false });
    expect(entries[1]).toEqual({ key: "AFTER", value: "ok", line: 4, exported: false });
  });

  it("handles '=' inside unquoted and quoted values", () => {
    const entries = parseEnvFile('EQ1=a=b=c\nEQ2="x=y=z"');
    expect(entries[0].value).toBe("a=b=c");
    expect(entries[1].value).toBe("x=y=z");
  });

  it("handles CRLF line endings", () => {
    const entries = parseEnvFile("FOO=bar\r\nBAZ=qux\r\n# comment\r\nQUUX=\r\n");
    expect(entries).toEqual([
      { key: "FOO", value: "bar", line: 1, exported: false },
      { key: "BAZ", value: "qux", line: 2, exported: false },
      { key: "QUUX", value: "", line: 4, exported: false },
    ]);
  });

  it("strips a leading UTF-8 BOM", () => {
    const entries = parseEnvFile("﻿FOO=bar\nBAZ=qux");
    expect(entries[0]).toEqual({ key: "FOO", value: "bar", line: 1, exported: false });
    expect(entries[1].key).toBe("BAZ");
  });

  it("skips blank lines and comment-only lines, keeps correct line numbers after them", () => {
    const entries = parseEnvFile("\n\n# comment\n\nKEY=value\n");
    expect(entries).toEqual([{ key: "KEY", value: "value", line: 5, exported: false }]);
  });

  it("returns an empty array for a file with no assignments", () => {
    expect(parseEnvFile("# just comments\n\n# and blanks\n")).toEqual([]);
  });

  it("does not choke on malformed / non-assignment lines", () => {
    const entries = parseEnvFile("not an assignment at all\nVALID=ok\n123INVALID=skipped\n");
    expect(entries).toEqual([{ key: "VALID", value: "ok", line: 2, exported: false }]);
  });
});

// ---------------------------------------------------------------------------
// scanShellProfile
// ---------------------------------------------------------------------------

describe("scanShellProfile", () => {
  it("finds exported and bare assignments among unrelated shell syntax, without executing anything", () => {
    const text = [
      "# ~/.bashrc excerpt",
      "alias ll='ls -la'",
      "export GROQ_API_KEY=gsk_abcdefghijklmnopqrstuvwxyz0123456789",
      'PATH="$PATH:/usr/local/bin"',
      "function greet() { echo hello; }",
      'export OPENAI_API_KEY="sk-proj-realkey1234567890"',
      "if [ -f ~/.env ]; then source ~/.env; fi",
    ].join("\n");

    const entries = scanShellProfile(text);
    expect(entries).toContainEqual({
      key: "GROQ_API_KEY",
      value: "gsk_abcdefghijklmnopqrstuvwxyz0123456789",
      line: 3,
    });
    expect(entries).toContainEqual({ key: "PATH", value: "$PATH:/usr/local/bin", line: 4 });
    expect(entries).toContainEqual({ key: "OPENAI_API_KEY", value: "sk-proj-realkey1234567890", line: 6 });
    // No "exported" field on this return type.
    for (const e of entries) expect(Object.keys(e).sort()).toEqual(["key", "line", "value"]);
  });
});

// ---------------------------------------------------------------------------
// harvestConfigSecrets
// ---------------------------------------------------------------------------

describe("harvestConfigSecrets", () => {
  it("walks nested vendor config JSON and harvests apiKey/api_key/token/secret/authorization-shaped fields", () => {
    const cfg: JsonValue = {
      name: "not-a-secret-field",
      services: {
        openai: { apiKey: "sk-proj-realkeylooking1234567890" },
        anthropic: { api_key: "sk-ant-api03-realkeylooking1234567890" },
      },
      clientSecret: "topsecretvalue1234567890",
      headers: { Authorization: "Bearer abcxyz1234567890tokenvalue" },
      nested: { deeply: { nested: { token: "deep-token-value-1234567890" } } },
      list: [{ apiKey: "in-array-key-1234567890" }],
    };
    const results = harvestConfigSecrets(cfg, { path: "/etc/vendor/config.json" });
    const byEnvVar = Object.fromEntries(results.map((r) => [r.envVar, r]));

    expect(byEnvVar.OPENAI_API_KEY).toMatchObject({
      material: "sk-proj-realkeylooking1234567890",
      provider: "openai",
    });
    expect(byEnvVar.OPENAI_API_KEY.locator).toContain("/etc/vendor/config.json");
    expect(byEnvVar.ANTHROPIC_API_KEY).toMatchObject({
      material: "sk-ant-api03-realkeylooking1234567890",
      provider: "anthropic",
    });
    expect(byEnvVar.CLIENT_SECRET).toMatchObject({ material: "topsecretvalue1234567890" });
    expect(byEnvVar.HEADERS_AUTHORIZATION ?? byEnvVar.AUTHORIZATION).toBeTruthy();
    expect(results.some((r) => r.material === "deep-token-value-1234567890")).toBe(true);

    // "name" must never be harvested — it isn't secret-shaped.
    expect(results.some((r) => r.material === "not-a-secret-field")).toBe(false);

    // Values inside arrays are still walked.
    expect(results.some((r) => r.material === "in-array-key-1234567890")).toBe(true);
  });

  it("ignores non-string secret-shaped fields and empty strings", () => {
    const cfg: JsonValue = { apiKey: 12345 as unknown as JsonValue, token: "", secret: null };
    expect(harvestConfigSecrets(cfg, { path: "/x.json" })).toEqual([]);
  });

  it("returns an empty array for a config with no secret-shaped fields", () => {
    const cfg: JsonValue = { name: "widget", version: "1.0.0", nested: { color: "blue" } };
    expect(harvestConfigSecrets(cfg, { path: "/x.json" })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// classifyProviderKey
// ---------------------------------------------------------------------------

describe("classifyProviderKey", () => {
  const knownProviderCases: Array<[string, string, string]> = [
    ["ANTHROPIC_API_KEY", "sk-ant-api03-realkeylooking1234567890ABCDEF", "anthropic"],
    ["OPENAI_API_KEY", "sk-proj-realkeylooking1234567890ABCDEF", "openai"],
    ["GOOGLE_API_KEY", "AIzaSyRealLookingKey1234567890ABCDEF", "google"],
    ["MISTRAL_API_KEY", "realkeylooking1234567890ABCDEFmistral", "mistral"],
    ["GROQ_API_KEY", "gsk_realkeylooking1234567890ABCDEF", "groq"],
    ["OPENROUTER_API_KEY", "sk-or-v1-realkeylooking1234567890ABCDEF", "openrouter"],
    ["TOGETHER_API_KEY", "realkeylooking1234567890ABCDEFtogether", "together"],
    ["DEEPSEEK_API_KEY", "realkeylooking1234567890ABCDEFdeepseek", "deepseek"],
    ["XAI_API_KEY", "xai-realkeylooking1234567890ABCDEF", "xai"],
    ["AZURE_OPENAI_API_KEY", "realkeylooking1234567890ABCDEFazure", "azure"],
  ];

  for (const [envVar, material, provider] of knownProviderCases) {
    it(`recognizes ${provider} via ${envVar}`, () => {
      const result = classifyProviderKey(envVar, material);
      expect(result.provider).toBe(provider);
      expect(result.looksValid).toBe(true);
    });
  }

  it("recognizes a provider from key-material shape alone (generic env var name)", () => {
    const result = classifyProviderKey("SOME_RANDOM_VAR", "sk-ant-api03-realkeylooking1234567890ABCDEF");
    expect(result.provider).toBe("anthropic");
  });

  it("falls back to 'unknown' for a generic *_API_KEY it cannot justify a provider for", () => {
    const result = classifyProviderKey("WIDGETCORP_API_KEY", "somewhatplausiblekeymaterial1234567890");
    expect(result.provider).toBe("unknown");
    expect(result.looksValid).toBe(true);
    expect(result.reason).toMatch(/generic/i);
  });

  it("never guesses a provider for an unrelated env var and unrecognized material", () => {
    const result = classifyProviderKey("MY_APP_SETTING", "just some regular config value");
    expect(result.provider).toBe("unknown");
  });

  it.each([
    ["sk-..."],
    ["changeme"],
    [""],
    ["<your-key>"],
    ["{{API_KEY}}"],
    ["xxxxxxxxxxxxxxxx"],
    ["YOUR_API_KEY"],
  ])("marks placeholder value %j as looksValid:false with a reason", (material) => {
    const result = classifyProviderKey("ANTHROPIC_API_KEY", material);
    expect(result.looksValid).toBe(false);
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it("a real-looking key is not flagged as a placeholder", () => {
    const result = classifyProviderKey("ANTHROPIC_API_KEY", "sk-ant-api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6");
    expect(result.looksValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// looksLikeKeyMaterial / redactValue
// ---------------------------------------------------------------------------

describe("looksLikeKeyMaterial", () => {
  it("accepts realistic key-shaped strings", () => {
    expect(looksLikeKeyMaterial("sk-ant-api03-A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6")).toBe(true);
    expect(looksLikeKeyMaterial("AIzaSyD9k2n8B7c6V5x4Z3a2S1d0F9g8H7j6K5l4")).toBe(true);
    expect(looksLikeKeyMaterial("gsk_" + "aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0")).toBe(true);
  });

  it("rejects short strings, plain sentences, and low-entropy repeats", () => {
    expect(looksLikeKeyMaterial("hello world this has spaces")).toBe(false);
    expect(looksLikeKeyMaterial("short")).toBe(false);
    expect(looksLikeKeyMaterial("")).toBe(false);
    expect(looksLikeKeyMaterial("xxxxxxxxxxxxxxxxxxxxxxxx")).toBe(false);
    expect(looksLikeKeyMaterial("00000000000000000000")).toBe(false);
  });

  it("rejects strings with characters outside a typical token charset", () => {
    expect(looksLikeKeyMaterial("this has spaces and is long enough 1234567890")).toBe(false);
    expect(looksLikeKeyMaterial("emoji-key-😀😀😀😀😀😀😀😀😀😀😀😀😀😀")).toBe(false);
  });
});

describe("redactValue", () => {
  it("keeps only the first/last 4 characters visible", () => {
    const redacted = redactValue("sk-ant-api03-verylongsecretvaluehere1234");
    expect(redacted.startsWith("sk-a")).toBe(true);
    expect(redacted.endsWith("1234")).toBe(true);
    expect(redacted).not.toContain("verylongsecret");
  });

  it("fully masks very short values", () => {
    expect(redactValue("short")).toBe("*****");
    expect(redactValue("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// SecretVault — the leak-proof invariant
// ---------------------------------------------------------------------------

describe("SecretVault", () => {
  const DISTINCTIVE = "sk-ant-DISTINCTIVE-CANARY-VALUE-9f8e7d6c5b4a3210";

  function seededVault(): SecretVault {
    const vault = new SecretVault();
    vault.add(
      {
        envVar: "ANTHROPIC_API_KEY",
        provider: "anthropic",
        origin: { path: "/home/user/.env", locator: "line 3" },
        confidence: 0.95,
        looksValid: true,
        note: "found in project .env",
      },
      DISTINCTIVE,
    );
    vault.add(
      {
        envVar: "OPENAI_API_KEY",
        provider: "openai",
        origin: { path: "/home/user/.bashrc" },
        confidence: 0.8,
        looksValid: true,
      },
      "sk-proj-anotherSECRETvalue0987654321",
    );
    return vault;
  }

  it("add() returns a descriptor with a computed fingerprint and length, no material", () => {
    const vault = new SecretVault();
    const descriptor = vault.add(
      { envVar: "FOO_API_KEY", provider: "unknown", origin: { path: "/x" }, confidence: 0.5, looksValid: true },
      "materialvalue12345",
    );
    expect(descriptor.envVar).toBe("FOO_API_KEY");
    expect(descriptor.length).toBe("materialvalue12345".length);
    expect(descriptor.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect((descriptor as unknown as { material?: unknown }).material).toBeUndefined();
  });

  it("list()/has()/size/take() behave as a straightforward metadata + retrieval API", () => {
    const vault = seededVault();
    expect(vault.size).toBe(2);
    expect(vault.has("ANTHROPIC_API_KEY")).toBe(true);
    expect(vault.has("NONEXISTENT")).toBe(false);
    expect(vault.take("ANTHROPIC_API_KEY")).toBe(DISTINCTIVE);
    expect(vault.take("NONEXISTENT")).toBeUndefined();
    expect(vault.list().map((d) => d.envVar)).toEqual(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);
    // take() is non-destructive: the descriptor list is unaffected by reads.
    expect(vault.size).toBe(2);
    expect(vault.list()[0].envVar).toBe("ANTHROPIC_API_KEY");
  });

  it("take() with duplicate envVars returns the most recently added material", () => {
    const vault = new SecretVault();
    vault.add(
      { envVar: "DUP_API_KEY", provider: "unknown", origin: { path: "/a" }, confidence: 0.5, looksValid: true },
      "first-material-value",
    );
    vault.add(
      { envVar: "DUP_API_KEY", provider: "unknown", origin: { path: "/b" }, confidence: 0.5, looksValid: true },
      "second-material-value",
    );
    expect(vault.take("DUP_API_KEY")).toBe("second-material-value");
    expect(vault.list().length).toBe(2);
  });

  it("LEAK-PROOF INVARIANT: JSON.stringify, template interpolation, util.inspect, and console.log never contain the material", () => {
    const vault = seededVault();
    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 10 }))).join(" "));
    };
    try {
      console.log(vault);
      console.log("vault:", vault);
    } finally {
      console.log = originalLog;
    }

    const surfaces = [
      JSON.stringify(vault),
      JSON.stringify({ nested: { vault } }),
      JSON.stringify(vault.list()),
      `${vault}`,
      `interpolated: ${vault} end`,
      inspect(vault),
      inspect(vault, { depth: null }),
      inspect(vault, { depth: 10, breakLength: 40 }),
      ...logged,
      // Individual descriptors too — "or any descriptor" per the invariant.
      ...vault.list().map((d) => JSON.stringify(d)),
      ...vault.list().map((d) => inspect(d, { depth: 10 })),
      ...vault.list().map((d) => `${JSON.stringify(d)}`),
    ];

    const otherMaterial = "sk-proj-anotherSECRETvalue0987654321";
    for (const surface of surfaces) {
      expect(surface).not.toContain(DISTINCTIVE);
      expect(surface).not.toContain(otherMaterial);
    }

    // Sanity check the invariant isn't vacuous: the surfaces DO mention the
    // env var names and provider (i.e. we're actually rendering something).
    expect(surfaces.some((s) => s.includes("ANTHROPIC_API_KEY"))).toBe(true);
  });

  it("toJSON() output round-trips through JSON.parse as descriptors only", () => {
    const vault = seededVault();
    const parsed = JSON.parse(JSON.stringify(vault)) as Array<{ envVar: string; fingerprint: string }>;
    expect(parsed.length).toBe(2);
    expect(parsed[0].envVar).toBe("ANTHROPIC_API_KEY");
    expect(parsed[0].fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(parsed)).not.toContain(DISTINCTIVE);
  });

  it("an empty vault reports size 0 and empty surfaces without throwing", () => {
    const vault = new SecretVault();
    expect(vault.size).toBe(0);
    expect(vault.list()).toEqual([]);
    expect(() => JSON.stringify(vault)).not.toThrow();
    expect(() => inspect(vault)).not.toThrow();
    expect(`${vault}`).toContain("0 secrets");
  });
});
