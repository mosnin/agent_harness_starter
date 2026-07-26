import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import type { AddressInfo, Socket } from "node:net";

import {
  BrowserDriver,
  probeDisplaySupport,
  resolveChromiumExecutable,
  type BrowserAction,
  type DriverPage,
} from "../driver";

// ---------------------------------------------------------------------------
// Real fixture HTTP server — zero external network, node:http only.
// ---------------------------------------------------------------------------

const FORM_HTML = `<!doctype html>
<html>
<head><title>Form Fixture</title></head>
<body>
  <input id="text-input" oninput="document.getElementById('input-echo').textContent = this.value" />
  <div id="input-echo"></div>

  <button id="click-btn" onclick="document.getElementById('click-result').textContent='clicked'">Click</button>
  <div id="click-result"></div>

  <select id="select-input" onchange="document.getElementById('select-echo').textContent=this.value">
    <option value="">--</option>
    <option value="alpha">Alpha</option>
    <option value="beta">Beta</option>
  </select>
  <div id="select-echo"></div>

  <input id="key-input" onkeydown="document.getElementById('key-result').textContent = event.key" />
  <div id="key-result"></div>

  <div style="height:4000px"></div>
  <div id="bottom">bottom marker</div>

  <script>
    window.addEventListener('scroll', function () {
      if (window.scrollY > 0 && !document.getElementById('scroll-happened')) {
        var d = document.createElement('div');
        d.id = 'scroll-happened';
        document.body.appendChild(d);
      }
    });
    setTimeout(function () {
      var d = document.createElement('div');
      d.id = 'late-arrival';
      d.textContent = 'I appeared late';
      document.body.appendChild(d);
    }, 300);
  </script>
</body>
</html>`;

const HOME_HTML = `<!doctype html><html><head><title>Fixture Home</title></head><body><h1>Hello Fixture</h1></body></html>`;
const FINAL_HTML = `<!doctype html><html><head><title>Final</title></head><body><p>Final Destination</p></body></html>`;

function startFixtureServer(): Promise<{ server: http.Server; baseUrl: string; sockets: Set<Socket> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url === "/home") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(HOME_HTML);
      return;
    }
    if (url === "/form") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FORM_HTML);
      return;
    }
    if (url === "/redirect1") {
      res.writeHead(302, { Location: "/redirect2" });
      res.end();
      return;
    }
    if (url === "/redirect2") {
      res.writeHead(302, { Location: "/final" });
      res.end();
      return;
    }
    if (url === "/final") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(FINAL_HTML);
      return;
    }
    if (url === "/missing") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    if (url === "/stall") {
      // Deliberately never respond — used to exercise navigation timeouts.
      sockets.add(res.socket as Socket);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}`, sockets });
    });
  });
}

// ---------------------------------------------------------------------------
// resolveChromiumExecutable — pure fs-fixture tests, no browser launch
// ---------------------------------------------------------------------------

describe("resolveChromiumExecutable", () => {
  let tmpRoot: string;

  beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pw-resolve-fixture-"));
  });
  afterAll(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function makeExecutable(base: string, dirName: string, relativeParts: string[]): void {
    const dir = path.join(base, dirName, ...relativeParts.slice(0, -1));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, relativeParts[relativeParts.length - 1]);
    fs.writeFileSync(file, "#!/bin/sh\necho fake-chromium\n", { mode: 0o755 });
  }

  it("reports ok:false with a clear reason for an empty directory", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "empty-"));
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain(dir);
    }
  });

  it("reports ok:false for a directory that does not exist", () => {
    const missing = path.join(tmpRoot, "does-not-exist-at-all");
    const result = resolveChromiumExecutable(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.toLowerCase()).toContain("cannot read");
    }
  });

  it("finds a headless-shell-only install", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "hs-only-"));
    makeExecutable(dir, "chromium_headless_shell-1150", ["chrome-linux", "headless_shell"]);
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("headless-shell");
      expect(result.version).toBe("1150");
      expect(result.path).toBe(path.join(dir, "chromium_headless_shell-1150", "chrome-linux", "headless_shell"));
    }
  });

  it("finds a chromium-only install", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "chromium-only-"));
    makeExecutable(dir, "chromium-1150", ["chrome-linux", "chrome"]);
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.kind).toBe("chromium");
      expect(result.version).toBe("1150");
    }
  });

  it("prefers headless-shell when both are installed", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "both-"));
    makeExecutable(dir, "chromium-900", ["chrome-linux", "chrome"]);
    makeExecutable(dir, "chromium_headless_shell-900", ["chrome-linux", "headless_shell"]);
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.kind).toBe("headless-shell");
  });

  it("picks the highest revision when multiple headless-shell installs exist", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "multi-rev-"));
    makeExecutable(dir, "chromium_headless_shell-1000", ["chrome-linux", "headless_shell"]);
    makeExecutable(dir, "chromium_headless_shell-2000", ["chrome-linux", "headless_shell"]);
    makeExecutable(dir, "chromium_headless_shell-1500", ["chrome-linux", "headless_shell"]);
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.version).toBe("2000");
  });

  it("ignores a matching directory whose binary is actually missing", () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, "hollow-"));
    fs.mkdirSync(path.join(dir, "chromium_headless_shell-1000", "chrome-linux"), { recursive: true });
    // no headless_shell file written inside
    const result = resolveChromiumExecutable(dir);
    expect(result.ok).toBe(false);
  });

  it("never throws, even for a path pointing at a file instead of a directory", () => {
    const filePath = path.join(tmpRoot, "not-a-dir.txt");
    fs.writeFileSync(filePath, "hello");
    expect(() => resolveChromiumExecutable(filePath)).not.toThrow();
    expect(resolveChromiumExecutable(filePath).ok).toBe(false);
  });

  it("resolves a real installed executable under /opt/pw-browsers", () => {
    const result = resolveChromiumExecutable("/opt/pw-browsers");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(fs.existsSync(result.path)).toBe(true);
      expect(fs.statSync(result.path).isFile()).toBe(true);
      expect(["headless-shell", "chromium"]).toContain(result.kind);
      expect(result.version.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// probeDisplaySupport
// ---------------------------------------------------------------------------

describe("probeDisplaySupport", () => {
  it("always reports headlessOk true", () => {
    expect(probeDisplaySupport({}).headlessOk).toBe(true);
    expect(probeDisplaySupport({ DISPLAY: ":0" }).headlessOk).toBe(true);
  });

  it("reports headedOk false with an honest reason when no display vars are set", () => {
    const result = probeDisplaySupport({ SOME_OTHER_VAR: "x" });
    expect(result.headedOk).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toMatch(/DISPLAY/);
  });

  it("reports headedOk true when DISPLAY is set", () => {
    const result = probeDisplaySupport({ DISPLAY: ":1" });
    expect(result.headedOk).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("reports headedOk true when WAYLAND_DISPLAY is set", () => {
    const result = probeDisplaySupport({ WAYLAND_DISPLAY: "wayland-0" });
    expect(result.headedOk).toBe(true);
  });

  it("treats blank/whitespace-only display values as absent", () => {
    const result = probeDisplaySupport({ DISPLAY: "   ", WAYLAND_DISPLAY: "" });
    expect(result.headedOk).toBe(false);
  });

  it("does not throw when called with no arguments", () => {
    expect(() => probeDisplaySupport()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real BrowserDriver / DriverPage tests — actual headless Chromium, real
// fixture HTTP server, real data: URLs. Only skipped if this environment
// genuinely has no Chromium installed (it does — /opt/pw-browsers).
// ---------------------------------------------------------------------------

const resolvedReal = resolveChromiumExecutable();

describe.skipIf(!resolvedReal.ok)("BrowserDriver", () => {
  let fixture: { server: http.Server; baseUrl: string; sockets: Set<Socket> };

  beforeAll(async () => {
    fixture = await startFixtureServer();
  }, 20000);

  afterAll(async () => {
    for (const socket of fixture.sockets) socket.destroy();
    await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  });

  // -- launch / lifecycle -----------------------------------------------

  describe("launch and lifecycle", () => {
    let driver: BrowserDriver;

    afterEach(async () => {
      if (driver && !driver.closed) await driver.close();
    });

    it("launches headless by default against the resolved executable", async () => {
      driver = await BrowserDriver.launch();
      expect(driver.headless).toBe(true);
      expect(driver.closed).toBe(false);
      if (resolvedReal.ok) expect(driver.executablePath).toBe(resolvedReal.path);
    }, 20000);

    it("honors an explicit executablePath override", async () => {
      expect(resolvedReal.ok).toBe(true);
      if (!resolvedReal.ok) return;
      driver = await BrowserDriver.launch({ executablePath: resolvedReal.path });
      expect(driver.executablePath).toBe(resolvedReal.path);
    }, 20000);

    it("throws an honest Error (the resolveChromiumExecutable reason) when no executable is found", async () => {
      const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-empty-launch-"));
      try {
        await expect(BrowserDriver.launch({ browsersPath: emptyDir })).rejects.toThrow(/no Chromium executable found/);
      } finally {
        fs.rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it("throws an honest Error for headless:false when no display is available", async () => {
      await expect(BrowserDriver.launch({ headless: false, env: { PATH: process.env.PATH } })).rejects.toThrow(
        /display/i
      );
    });

    it("enforces maxPages and frees a slot when a page is closed", async () => {
      driver = await BrowserDriver.launch({ maxPages: 2 });
      const p1 = await driver.newPage();
      const p2 = await driver.newPage();
      expect(driver.pages().length).toBe(2);
      await expect(driver.newPage()).rejects.toThrow(/maximum/i);

      await p1.close();
      expect(driver.pages().length).toBe(1);
      const p3 = await driver.newPage();
      expect(driver.pages().length).toBe(2);
      await p2.close();
      await p3.close();
    }, 20000);

    it("close() is idempotent (double-close does not throw)", async () => {
      driver = await BrowserDriver.launch();
      await driver.close();
      await expect(driver.close()).resolves.toBeUndefined();
      expect(driver.closed).toBe(true);
    }, 20000);

    it("newPage() after driver.close() rejects deterministically instead of hanging", async () => {
      driver = await BrowserDriver.launch();
      await driver.close();
      await expect(driver.newPage()).rejects.toThrow(/closed/i);
    }, 20000);

    it("double-close and use-after-close on a page return deterministic closed-page results", async () => {
      driver = await BrowserDriver.launch();
      const p = await driver.newPage();
      await p.close();
      await expect(p.close()).resolves.toBeUndefined();
      expect(p.closed).toBe(true);

      const nav = await p.goto("http://example.invalid/");
      expect(nav.ok).toBe(false);
      expect(nav.error?.message).toMatch(/closed/i);

      const act = await p.act({ kind: "click", selector: "#anything" });
      expect(act.ok).toBe(false);
      expect(act.error?.message).toMatch(/closed/i);

      const shot = await p.screenshot();
      expect(shot.ok).toBe(false);

      await expect(p.title()).resolves.toBe("");
      await expect(p.html()).resolves.toBe("");
      await expect(p.text()).resolves.toBeUndefined();
      expect(() => p.url()).not.toThrow();
    }, 20000);
  });

  // -- navigation ----------------------------------------------------------

  describe("navigation", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch();
      page = await driver.newPage();
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("navigates a real page and reads title/html back", async () => {
      const result = await page.goto(`${fixture.baseUrl}/`);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.finalUrl).toBe(`${fixture.baseUrl}/`);
      expect(result.redirects).toEqual([]);
      await expect(page.title()).resolves.toBe("Fixture Home");
      await expect(page.html()).resolves.toContain("Hello Fixture");
      await expect(page.text("h1")).resolves.toBe("Hello Fixture");
    });

    it("follows a real multi-hop redirect chain and records it", async () => {
      const result = await page.goto(`${fixture.baseUrl}/redirect1`);
      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.finalUrl).toBe(`${fixture.baseUrl}/final`);
      expect(result.redirects).toEqual([`${fixture.baseUrl}/redirect1`, `${fixture.baseUrl}/redirect2`]);
      await expect(page.title()).resolves.toBe("Final");
    });

    it("reports http-error with the real status code on 4xx", async () => {
      const result = await page.goto(`${fixture.baseUrl}/missing`);
      expect(result.ok).toBe(false);
      expect(result.status).toBe(404);
      expect(result.error?.code).toBe("http-error");
    });

    it("allows about:blank", async () => {
      const result = await page.goto("about:blank");
      expect(result.ok).toBe(true);
    });

    it("rejects javascript: with bad-scheme, without touching Playwright navigation", async () => {
      const before = page.url();
      const result = await page.goto("javascript:alert(1)");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-scheme");
      expect(page.url()).toBe(before);
    });

    it("rejects data: URLs by default", async () => {
      const result = await page.goto("data:text/html,<h1>hi</h1>");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-scheme");
    });

    it("rejects file: URLs by default", async () => {
      const result = await page.goto("file:///etc/hostname");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-scheme");
    });

    it("reports a malformed URL as bad-scheme rather than throwing", async () => {
      const result = await page.goto("not a url at all");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-scheme");
    });

    it("produces a real net-error for a connection that is actually refused", async () => {
      const probe = await startFixtureServer();
      const deadPort = new URL(probe.baseUrl).port;
      await new Promise<void>((resolve) => probe.server.close(() => resolve()));
      const result = await page.goto(`http://127.0.0.1:${deadPort}/`);
      expect(result.ok).toBe(false);
      expect(["net-error", "timeout"]).toContain(result.error?.code);
    }, 10000);
  });

  describe("navigation with allowDataUrls", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch({ allowDataUrls: true });
      page = await driver.newPage();
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("allows data:text/html when the flag is set", async () => {
      const result = await page.goto("data:text/html,<title>DataPage</title><h1>hi</h1>");
      expect(result.ok).toBe(true);
      await expect(page.title()).resolves.toBe("DataPage");
    });

    it("still rejects non-html data: subtypes even with the flag set", async () => {
      const result = await page.goto("data:text/plain,hello");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-scheme");
    });
  });

  describe("navigation with allowFileUrls", () => {
    let driver: BrowserDriver;
    let page: DriverPage;
    let tmpFile: string;

    beforeAll(async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-file-fixture-"));
      tmpFile = path.join(dir, "page.html");
      fs.writeFileSync(tmpFile, `<!doctype html><html><head><title>LocalFile</title></head><body>local</body></html>`);
      driver = await BrowserDriver.launch({ allowFileUrls: true });
      page = await driver.newPage();
    }, 20000);

    afterAll(async () => {
      await driver.close();
      fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    });

    it("allows file: URLs when the flag is set", async () => {
      const result = await page.goto(`file://${tmpFile}`);
      expect(result.ok).toBe(true);
      await expect(page.title()).resolves.toBe("LocalFile");
    });
  });

  describe("navigation with blockHosts", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch({ blockHosts: ["Evil.com"] });
      page = await driver.newPage();
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("blocks an exact host match", async () => {
      const result = await page.goto("http://evil.com/x");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("blocked-host");
    });

    it("blocks a subdomain of a blocked host", async () => {
      const result = await page.goto("http://sub.evil.com/x");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("blocked-host");
    });

    it("blocks case-insensitively", async () => {
      const result = await page.goto("http://EVIL.COM/x");
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("blocked-host");
    });

    it("does not block an unrelated host", async () => {
      const result = await page.goto(`${fixture.baseUrl}/`);
      expect(result.ok).toBe(true);
    });

    it("does not block a host that merely contains the blocked string as a substring", async () => {
      const result = await page.goto("http://notevilcompany.example.invalid/x");
      // Not blocked by policy (fails, if at all, only on real DNS as net-error) —
      // the key assertion is that it is NOT rejected as blocked-host.
      expect(result.error?.code).not.toBe("blocked-host");
    }, 10000);
  });

  describe("navigation timeout", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch({ navTimeoutMs: 400 });
      page = await driver.newPage();
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("maps a real stalled navigation to NavErrorCode 'timeout'", async () => {
      const result = await page.goto(`${fixture.baseUrl}/stall`);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("timeout");
    }, 10000);
  });

  // -- act() -----------------------------------------------------------

  describe("act()", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch();
      page = await driver.newPage();
      const nav = await page.goto(`${fixture.baseUrl}/form`);
      expect(nav.ok).toBe(true);
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("rejects an unknown action kind as bad-action without touching the page", async () => {
      const action = { kind: "teleport" } as unknown as BrowserAction;
      const result = await page.act(action);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("bad-action");
    });

    it("rejects click/type/select/waitFor missing a selector as no-selector", async () => {
      for (const kind of ["click", "type", "select", "waitFor"] as const) {
        const result = await page.act({ kind } as BrowserAction);
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe("no-selector");
      }
    });

    it("rejects type missing text, select missing value, and press missing key as bad-action", async () => {
      const typeResult = await page.act({ kind: "type", selector: "#text-input" });
      expect(typeResult.error?.code).toBe("bad-action");

      const selectResult = await page.act({ kind: "select", selector: "#select-input" });
      expect(selectResult.error?.code).toBe("bad-action");

      const pressResult = await page.act({ kind: "press" });
      expect(pressResult.error?.code).toBe("bad-action");
    });

    it("performs a real click and observes the real DOM update", async () => {
      const result = await page.act({ kind: "click", selector: "#click-btn" });
      expect(result.ok).toBe(true);
      await expect(page.text("#click-result")).resolves.toBe("clicked");
    });

    it("returns not-found for a click on a selector with zero matches", async () => {
      const result = await page.act({ kind: "click", selector: "#does-not-exist-anywhere" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not-found");
    });

    it("performs a real type (fill) and observes the input event fire", async () => {
      const result = await page.act({ kind: "type", selector: "#text-input", text: "hello world" });
      expect(result.ok).toBe(true);
      await expect(page.text("#input-echo")).resolves.toBe("hello world");
    });

    it("performs a real select and observes the change event fire", async () => {
      const result = await page.act({ kind: "select", selector: "#select-input", value: "beta" });
      expect(result.ok).toBe(true);
      await expect(page.text("#select-echo")).resolves.toBe("beta");
    });

    it("performs a real press against a focused selector", async () => {
      const result = await page.act({ kind: "press", selector: "#key-input", key: "A" });
      expect(result.ok).toBe(true);
      await expect(page.text("#key-result")).resolves.toBe("A");
    });

    it("performs a real press with no selector against whatever already has focus", async () => {
      const focus = await page.act({ kind: "click", selector: "#key-input" });
      expect(focus.ok).toBe(true);
      const result = await page.act({ kind: "press", key: "B" });
      expect(result.ok).toBe(true);
      await expect(page.text("#key-result")).resolves.toBe("B");
    });

    it("performs a real deltaY scroll and observes the scroll event fire", async () => {
      const result = await page.act({ kind: "scroll", deltaY: 800 });
      expect(result.ok).toBe(true);
      const waited = await page.act({ kind: "waitFor", selector: "#scroll-happened", timeoutMs: 2000 });
      expect(waited.ok).toBe(true);
    });

    it("performs a real scroll to a selector", async () => {
      const result = await page.act({ kind: "scroll", selector: "#bottom" });
      expect(result.ok).toBe(true);
    });

    it("returns not-found for a scroll targeting a nonexistent selector", async () => {
      const result = await page.act({ kind: "scroll", selector: "#nowhere-to-be-found" });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("not-found");
    });

    it("waitFor succeeds once the element really appears", async () => {
      const p2 = await driver.newPage();
      try {
        await p2.goto(`${fixture.baseUrl}/form`);
        const result = await p2.act({ kind: "waitFor", selector: "#late-arrival", timeoutMs: 2000 });
        expect(result.ok).toBe(true);
        await expect(p2.text("#late-arrival")).resolves.toBe("I appeared late");
      } finally {
        await p2.close();
      }
    }, 10000);

    it("waitFor times out on a selector that never appears", async () => {
      const result = await page.act({ kind: "waitFor", selector: "#never-ever-appears", timeoutMs: 300 });
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("timeout");
    }, 10000);
  });

  // -- screenshot() ------------------------------------------------------

  describe("screenshot()", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch();
      page = await driver.newPage();
      await page.goto(`${fixture.baseUrl}/`);
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("returns a decodable PNG with a real signature and nonzero dimensions", async () => {
      const result = await page.screenshot();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);

      const buf = Buffer.from(result.pngBase64, "base64");
      const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
      for (let i = 0; i < pngSignature.length; i++) {
        expect(buf[i]).toBe(pngSignature[i]);
      }
      // Round-trips through the exact base64 alphabet vision_describe expects (no data: prefix).
      expect(result.pngBase64.startsWith("data:")).toBe(false);
      expect(/^[A-Za-z0-9+/]+=*$/.test(result.pngBase64)).toBe(true);
    });
  });

  // -- text()/html()/title()/url() misc -----------------------------------

  describe("page reads", () => {
    let driver: BrowserDriver;
    let page: DriverPage;

    beforeAll(async () => {
      driver = await BrowserDriver.launch();
      page = await driver.newPage();
      await page.goto(`${fixture.baseUrl}/`);
    }, 20000);

    afterAll(async () => {
      await driver.close();
    });

    it("text() with no selector returns the body text", async () => {
      await expect(page.text()).resolves.toContain("Hello Fixture");
    });

    it("text() with a non-matching selector returns undefined instead of throwing", async () => {
      await expect(page.text("#totally-absent")).resolves.toBeUndefined();
    });

    it("url() reflects the current page URL", () => {
      expect(page.url()).toBe(`${fixture.baseUrl}/`);
    });
  });
});
