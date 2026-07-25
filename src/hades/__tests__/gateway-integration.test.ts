/**
 * Central-integration tests for the Phase-7 gateway surface: proves the new
 * modules are actually reachable from the product (root barrel, `hades`
 * bin, `hades gateway` CLI) and that the composed production pipeline
 * (PairingGuard → ContinuityRouter → BadgeStamper → AgentGatewayHandler →
 * GatewayProcess) really works end-to-end — not just each module in
 * isolation.
 */
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { loadConfig } from "../config/config";
import { buildGatewayDeps } from "../cli/gateway-deps";
import { runGatewayCommand } from "../cli/gateway-command";
import { main } from "../bin/hades";
import { InMemoryConnector } from "../gateway/in-memory-connector";
import { buildMessage } from "../gateway/connectors/email-mime";
import { SmtpClient } from "../gateway/connectors/smtp-client";
import type { TextSocket } from "../gateway/connectors/smtp-client";
import { ImapClient } from "../gateway/connectors/imap-client";
import type { GatewayPlatform } from "../../swarm-runtime/gateway/gateway";

// Reachability: every new gateway module must be importable from the ROOT
// hades barrel — dead code hidden behind an unexported path is the failure
// mode this cycle's integration exists to prevent.
import {
  PairingGuard,
  BadgeStamper,
  GatewayProcess,
  AgentGatewayHandler,
  echoEngine,
  InMemoryTrustStore,
  FileTrustStore,
  EmailConnector,
  EMAIL_PLATFORM,
  runGatewayBench,
  assertConnectorContract,
  buildConnectorsFromEnv,
  chunkMessage,
  platformFormat,
  runGatewayCommand as runGatewayCommandFromBarrel,
  buildGatewayDeps as buildGatewayDepsFromBarrel,
} from "../index";

const dirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hades-gw-int-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("root barrel reachability", () => {
  it("exports the whole new gateway surface from the hades root index", () => {
    // Values (classes/functions) — not just types — must survive the barrel.
    expect(typeof PairingGuard).toBe("function");
    expect(typeof BadgeStamper).toBe("function");
    expect(typeof GatewayProcess).toBe("function");
    expect(typeof AgentGatewayHandler).toBe("function");
    expect(typeof echoEngine).toBe("function");
    expect(typeof InMemoryTrustStore).toBe("function");
    expect(typeof FileTrustStore).toBe("function");
    expect(typeof EmailConnector).toBe("function");
    expect(typeof runGatewayBench).toBe("function");
    expect(typeof assertConnectorContract).toBe("function");
    expect(typeof buildConnectorsFromEnv).toBe("function");
    expect(typeof chunkMessage).toBe("function");
    expect(typeof platformFormat).toBe("function");
    expect(typeof runGatewayCommandFromBarrel).toBe("function");
    expect(typeof buildGatewayDepsFromBarrel).toBe("function");
  });

  it('makes "email" a first-class GatewayPlatform (no cast required)', () => {
    // Type-level: this assignment only compiles because the central union
    // in swarm-runtime/gateway/gateway.ts now includes "email".
    const p: GatewayPlatform = "email";
    expect(p).toBe("email");
    expect(EMAIL_PLATFORM).toBe("email");
    // The email platform also has a real formatting entry, not the fallback.
    expect(platformFormat("email")).toEqual({ maxChars: 100000, style: "plain" });
  });
});

describe("buildGatewayDeps → runGatewayCommand (the real composed pipeline)", () => {
  it("gates, pairs, echoes with the honest [mock] engine, and stamps a badge — end to end", async () => {
    const config = loadConfig({ overrides: { dataDir: tempDataDir() } });
    const connector = new InMemoryConnector("telegram");
    const deps = buildGatewayDeps(config, {}, { connectors: [connector], report: [{ platform: "telegram", mode: "real", detail: "in-memory test connector" }] });

    await deps.process.start();
    try {
      // 1. Unknown handle → pairing prompt, never the agent.
      const gated = await connector.receive({ user: "u1", channel: "c1", text: "hello?" });
      expect(gated.accepted).toBe(false);
      expect(gated.text).toContain("/pair");
      expect(gated.text).not.toContain("[mock]");

      // 2. Pair with a code issued exactly the way `hades gateway pair` does.
      const issued = deps.pairing.issuePairingCode();
      const paired = await connector.receive({ user: "u1", channel: "c1", text: `/pair ${issued.code}` });
      expect(paired.accepted).toBe(true);
      expect(paired.text).toContain("Paired");

      // 3. A real turn now flows the whole pipeline: honest mock engine reply
      //    plus a BadgeStamper-appended badge line (unverified — the echo
      //    engine attaches no STYX evidence, and nothing may fake any).
      const reply = await connector.receive({ user: "u1", channel: "c1", text: "ship it" });
      expect(reply.accepted).toBe(true);
      expect(reply.text).toContain("[mock]");
      expect(reply.text).toContain("ship it");
      expect(reply.text).toContain("◻︎ unverified");
      // No certificate material can ever ride a wire reply.
      expect(JSON.stringify(reply)).not.toContain("signature");

      // 4. Trust is durable: the FileTrustStore wrote the paired handle to disk.
      const persisted = JSON.parse(readFileSync(deps.trustPath, "utf8")) as Array<{ key: string; level: string }>;
      expect(persisted).toEqual([expect.objectContaining({ key: "telegram:u1", level: "trusted" })]);

      // 5. Counters observed the real traffic.
      const status = deps.process.status();
      expect(status.running).toBe(true);
      expect(status.counters.inbound).toBeGreaterThanOrEqual(3);
      expect(status.counters.outbound).toBeGreaterThanOrEqual(2);
    } finally {
      await deps.process.stop();
    }
  });

  it("`gateway pair` + `gateway status` + `gateway bench` run for real through runGatewayCommand", async () => {
    const config = loadConfig({ overrides: { dataDir: tempDataDir() } });
    const deps = buildGatewayDeps(config, {});

    const pair = await runGatewayCommand(["pair", "--owner"], deps);
    expect(pair.code).toBe(0);
    expect(pair.lines[0]).toMatch(/^Pairing code: [A-Za-z0-9]{4,12}$/);
    expect(pair.lines[1]).toBe("Level: owner");

    const status = await runGatewayCommand(["status"], deps);
    expect(status.code).toBe(0);
    expect(status.lines[0]).toBe("gateway: stopped");
    // All six platforms probed; with an empty env every one is honestly offline.
    for (const platform of ["telegram", "discord", "slack", "whatsapp", "signal", "email"]) {
      expect(status.lines.join("\n")).toContain(platform);
    }
    expect(status.lines.join("\n")).not.toContain("real");

    // The REAL bench (no mocks anywhere in this call path): six connectors,
    // fake transports, mock engine — and it says so itself.
    const bench = await runGatewayCommand(["bench"], deps);
    expect(bench.code).toBe(0);
    expect(bench.lines[0]).toContain("mock engine, fake transports");
    expect(bench.lines.join("\n")).toContain("Cross-platform continuity: yes");
  });
});

describe("hades bin wiring", () => {
  const ENV_VARS = [
    "HADES_TELEGRAM_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "HADES_DISCORD_TOKEN",
    "DISCORD_BOT_TOKEN",
    "HADES_SLACK_TOKEN",
    "SLACK_BOT_TOKEN",
    "HADES_WHATSAPP_TOKEN",
    "HADES_WHATSAPP_PHONE_ID",
    "HADES_SIGNAL_URL",
    "HADES_SIGNAL_NUMBER",
    "HADES_EMAIL_ADDRESS",
    "HADES_EMAIL_IMAP_HOST",
    "HADES_EMAIL_SMTP_HOST",
    "HADES_EMAIL_USER",
    "HADES_EMAIL_PASS",
  ];

  it("`hades gateway start --probe` reaches the real gateway command (no stub), naming env vars only", async () => {
    const saved = new Map<string, string | undefined>();
    for (const name of ENV_VARS) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
    const savedDataDir = process.env.HADES_DATA_DIR;
    process.env.HADES_DATA_DIR = tempDataDir();

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await main(["gateway", "start", "--probe"]);
      expect(code).toBe(0);
      const out = logs.join("\n");
      // The old stub said "Gateway is available via the ConnectorHub API" —
      // the bin must now run the real probe instead.
      expect(out).not.toContain("ConnectorHub API");
      expect(out).toContain("gateway: --probe (not started)");
      for (const platform of ["telegram", "discord", "slack", "whatsapp", "signal", "email"]) {
        expect(out).toContain(platform);
      }
      expect(out).toContain("missing HADES_TELEGRAM_TOKEN");
      // Streamed lines must not be printed a second time by main()'s own loop.
      const probeHeaderCount = logs.filter((l) => l.includes("gateway: --probe")).length;
      expect(probeHeaderCount).toBe(1);
    } finally {
      console.log = origLog;
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      if (savedDataDir === undefined) delete process.env.HADES_DATA_DIR;
      else process.env.HADES_DATA_DIR = savedDataDir;
    }
  });

  it("`hades gateway help` routes through the real command table", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      const code = await main(["gateway", "help"]);
      expect(code).toBe(0);
      const out = logs.join("\n");
      expect(out).toContain("hades gateway — real multi-platform messaging gateway");
      for (const sub of ["start", "status", "pair", "send", "bench"]) {
        expect(out).toContain(sub);
      }
    } finally {
      console.log = origLog;
    }
  });
});

describe("email-mime threading-header injection hardening", () => {
  const base = {
    from: { address: "bot@example.test" },
    messageId: "<mid@example.test>",
    date: new Date(0),
  };

  it("rejects CR/LF smuggled through inReplyTo", () => {
    expect(() =>
      buildMessage({
        ...base,
        mail: {
          to: [{ address: "a@example.test" }],
          subject: "hi",
          text: "body",
          inReplyTo: "<x@example.test>\r\nBcc: victim@example.test",
        },
      }),
    ).toThrow(/In-Reply-To.*header injection/);
  });

  it("rejects CR/LF smuggled through a references entry", () => {
    expect(() =>
      buildMessage({
        ...base,
        mail: {
          to: [{ address: "a@example.test" }],
          subject: "hi",
          text: "body",
          references: ["<ok@example.test>", "<x@example.test>\nBcc: victim@example.test"],
        },
      }),
    ).toThrow(/References entry.*header injection/);
  });

  it("SmtpClient rejects CR/LF and angle brackets in envelope addresses before touching the socket", async () => {
    let dialed = false;
    const neverDial = async (): Promise<TextSocket> => {
      dialed = true;
      throw new Error("socket must never be dialed for an illegal envelope address");
    };
    const client = new SmtpClient({ host: "h", port: 465, user: "u", pass: "p", socketFactory: neverDial });
    const mail = { to: [{ address: "victim@example.test>\r\nRCPT TO:<other@example.test" }], subject: "s", text: "t", raw: "raw" };
    await expect(client.sendMail("bot@example.test", mail)).rejects.toThrow(/RCPT TO address contains illegal characters/);
    await expect(client.sendMail("bot@example.test\r\nQUIT", { ...mail, to: [{ address: "ok@example.test" }] })).rejects.toThrow(
      /MAIL FROM address contains illegal characters/,
    );
    expect(dialed).toBe(false);
  });

  it("ImapClient refuses credentials that would splice commands into the LOGIN line", async () => {
    let wrote = "";
    const scriptedSocket = async (): Promise<TextSocket> => ({
      write(data: string) {
        wrote += data;
      },
      onData() {},
      onError() {},
      end() {},
    });
    const client = new ImapClient({ host: "h", port: 993, user: "u", pass: "p\r\na002 DELETE INBOX", socketFactory: scriptedSocket, timeoutMs: 50 });
    await expect(client.fetchNewer(0)).rejects.toThrow(/IMAP quoted string cannot contain CR, LF, or NUL/);
    expect(wrote).not.toContain("DELETE INBOX");
  });

  it("still threads clean inbound-derived headers untouched", () => {
    const raw = buildMessage({
      ...base,
      mail: {
        to: [{ address: "a@example.test" }],
        subject: "Re: hi",
        text: "body",
        inReplyTo: "<parent@example.test>",
        references: ["<root@example.test>", "<parent@example.test>"],
      },
    });
    expect(raw).toContain("In-Reply-To: <parent@example.test>");
    expect(raw).toContain("References: <root@example.test> <parent@example.test>");
  });
});
