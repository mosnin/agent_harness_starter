import { describe, expect, it, vi, afterEach } from "vitest";

import {
  ALL_EGRESS_SEAMS,
  AirgapViolationError,
  engageAirgap,
  probeAirgap,
  withAirgap,
  type AirgapTarget,
  type EgressAttempt,
} from "../airgap";

// ---------------------------------------------------------------------------
// Synthetic target builders
// ---------------------------------------------------------------------------

function fakeFn(name: string): ((...a: unknown[]) => unknown) & { calls: unknown[][] } {
  const fn = ((...a: unknown[]) => `${name}-result`) as ((...a: unknown[]) => unknown) & { calls: unknown[][] };
  fn.calls = [];
  const wrapped = (...a: unknown[]): unknown => {
    fn.calls.push(a);
    return `${name}-result`;
  };
  (wrapped as typeof fn).calls = fn.calls;
  return wrapped as typeof fn;
}

function freshSyntheticTarget(): {
  target: AirgapTarget;
  originals: {
    fetch: ReturnType<typeof fakeFn>;
    httpRequest: ReturnType<typeof fakeFn>;
    httpGet: ReturnType<typeof fakeFn>;
    httpsRequest: ReturnType<typeof fakeFn>;
    httpsGet: ReturnType<typeof fakeFn>;
    netConnect: ReturnType<typeof fakeFn>;
    netCreateConnection: ReturnType<typeof fakeFn>;
    socketConnect: ReturnType<typeof fakeFn>;
    dnsLookup: ReturnType<typeof fakeFn>;
    dnsResolve: ReturnType<typeof fakeFn>;
    dnsPromisesLookup: ReturnType<typeof fakeFn>;
    dnsPromisesResolve: ReturnType<typeof fakeFn>;
    tlsConnect: ReturnType<typeof fakeFn>;
  };
} {
  const fetch = fakeFn("fetch");
  const httpRequest = fakeFn("http.request");
  const httpGet = fakeFn("http.get");
  const httpsRequest = fakeFn("https.request");
  const httpsGet = fakeFn("https.get");
  const netConnect = fakeFn("net.connect");
  const netCreateConnection = fakeFn("net.createConnection");
  const socketConnect = fakeFn("Socket.prototype.connect");
  const dnsLookup = fakeFn("dns.lookup");
  const dnsResolve = fakeFn("dns.resolve");
  const dnsPromisesLookup = fakeFn("dns.promises.lookup");
  const dnsPromisesResolve = fakeFn("dns.promises.resolve");
  const tlsConnect = fakeFn("tls.connect");

  const globals: { fetch?: unknown } = { fetch };
  const target: AirgapTarget = {
    globals,
    http: { request: httpRequest, get: httpGet },
    https: { request: httpsRequest, get: httpsGet },
    net: {
      connect: netConnect,
      createConnection: netCreateConnection,
      Socket: { prototype: { connect: socketConnect } },
    },
    dns: {
      lookup: dnsLookup,
      resolve: dnsResolve,
      promises: { lookup: dnsPromisesLookup, resolve: dnsPromisesResolve },
    },
    tls: { connect: tlsConnect },
  };

  return {
    target,
    originals: {
      fetch,
      httpRequest,
      httpGet,
      httpsRequest,
      httpsGet,
      netConnect,
      netCreateConnection,
      socketConnect,
      dnsLookup,
      dnsResolve,
      dnsPromisesLookup,
      dnsPromisesResolve,
      tlsConnect,
    },
  };
}

const openSessions: Array<{ release: () => void }> = [];
afterEach(() => {
  while (openSessions.length > 0) openSessions.pop()!.release();
});

function engage(opts: Parameters<typeof engageAirgap>[0]): ReturnType<typeof engageAirgap> {
  const s = engageAirgap(opts);
  openSessions.push(s);
  return s;
}

// ---------------------------------------------------------------------------
// Per-seam interdiction — no I/O, correct seam/target recorded
// ---------------------------------------------------------------------------

describe("engageAirgap — per-seam interdiction against a synthetic target", () => {
  it("fetch: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    expect(() => (target.globals.fetch as (...a: unknown[]) => unknown)("https://example.com")).toThrow(AirgapViolationError);
    expect(originals.fetch.calls.length).toBe(0);
    const attempts = session.attempts();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ seam: "fetch", target: "https://example.com", blocked: true });
    session.release();
  });

  it("http.request: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const http = target.http as { request: (...a: unknown[]) => unknown };
    expect(() => http.request("http://example.com/path")).toThrow(AirgapViolationError);
    expect(originals.httpRequest.calls.length).toBe(0);
    expect(session.attempts()[0]).toMatchObject({ seam: "http", target: "http://example.com/path", blocked: true });
    session.release();
  });

  it("https.get: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const https = target.https as { get: (...a: unknown[]) => unknown };
    expect(() => https.get({ hostname: "example.com", port: 443 })).toThrow(AirgapViolationError);
    expect(originals.httpsGet.calls.length).toBe(0);
    expect(session.attempts()[0]).toMatchObject({ seam: "https", target: "example.com:443", blocked: true });
    session.release();
  });

  it("net.Socket.prototype.connect: blocks and records, never calls through, preserves `this`", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const netObj = target.net as { Socket: { prototype: { connect: (...a: unknown[]) => unknown } } };
    const fakeSocket = { marker: "socket-instance" };
    expect(() => netObj.Socket.prototype.connect.call(fakeSocket, { host: "example.com", port: 9999 })).toThrow(AirgapViolationError);
    expect(originals.socketConnect.calls.length).toBe(0);
    expect(session.attempts()[0]).toMatchObject({ seam: "net-socket", target: "example.com:9999", blocked: true });
    session.release();
  });

  it("net.connect and net.createConnection are also blocked", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target });
    const netObj = target.net as { connect: (...a: unknown[]) => unknown; createConnection: (...a: unknown[]) => unknown };
    expect(() => netObj.connect(9999, "example.com")).toThrow(AirgapViolationError);
    expect(() => netObj.createConnection("/tmp/some.sock")).toThrow(AirgapViolationError);
    session.release();
  });

  it("dns.lookup: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const dns = target.dns as { lookup: (...a: unknown[]) => unknown };
    expect(() => dns.lookup("example.com", () => {})).toThrow(AirgapViolationError);
    expect(originals.dnsLookup.calls.length).toBe(0);
    expect(session.attempts()[0]).toMatchObject({ seam: "dns", target: "example.com", blocked: true });
    session.release();
  });

  it("dns.promises.resolve: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const dns = target.dns as { promises: { resolve: (...a: unknown[]) => unknown } };
    expect(() => dns.promises.resolve("example.com")).toThrow(AirgapViolationError);
    expect(originals.dnsPromisesResolve.calls.length).toBe(0);
    expect(session.attempts().some((a) => a.seam === "dns" && a.target === "example.com")).toBe(true);
    session.release();
  });

  it("tls.connect: blocks and records, never calls through", () => {
    const { target, originals } = freshSyntheticTarget();
    const session = engage({ target });
    const tls = target.tls as { connect: (...a: unknown[]) => unknown };
    expect(() => tls.connect(443, "example.com")).toThrow(AirgapViolationError);
    expect(originals.tlsConnect.calls.length).toBe(0);
    expect(session.attempts()[0]).toMatchObject({ seam: "tls", target: "example.com:443", blocked: true });
    session.release();
  });

  it("thrown AirgapViolationError carries the exact seam and target", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target });
    try {
      (target.globals.fetch as (...a: unknown[]) => unknown)("https://exfiltrate.example");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AirgapViolationError);
      const e = err as InstanceType<typeof AirgapViolationError>;
      expect(e.seam).toBe("fetch");
      expect(e.target).toBe("https://exfiltrate.example");
    }
    session.release();
  });
});

// ---------------------------------------------------------------------------
// Policy exceptions — loopback / unix socket / allowHosts, only when enabled
// ---------------------------------------------------------------------------

describe("engageAirgap — policy exceptions only apply when explicitly enabled", () => {
  it("loopback is blocked by default, allowed only with allowLoopback: true", () => {
    const { target: t1, originals: o1 } = freshSyntheticTarget();
    const s1 = engage({ target: t1 });
    expect(() => (t1.globals.fetch as (...a: unknown[]) => unknown)("http://127.0.0.1:8080")).toThrow(AirgapViolationError);
    expect(o1.fetch.calls.length).toBe(0);
    s1.release();

    const { target: t2, originals: o2 } = freshSyntheticTarget();
    const s2 = engage({ target: t2, policy: { allowLoopback: true } });
    expect(() => (t2.globals.fetch as (...a: unknown[]) => unknown)("http://127.0.0.1:8080")).not.toThrow();
    expect(o2.fetch.calls.length).toBe(1);
    expect(s2.attempts()[0]).toMatchObject({ blocked: false });
    s2.release();
  });

  it("localhost and ::1 are recognized loopback forms", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowLoopback: true } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("http://localhost:3000")).not.toThrow();
    expect(() => fetchFn("http://[::1]:3000")).not.toThrow();
    session.release();
  });

  it("unix sockets are blocked by default, allowed only with allowUnixSocket: true", () => {
    const { target: t1, originals: o1 } = freshSyntheticTarget();
    const s1 = engage({ target: t1 });
    const net1 = t1.net as { connect: (...a: unknown[]) => unknown };
    expect(() => net1.connect("/var/run/docker.sock")).toThrow(AirgapViolationError);
    expect(o1.netConnect.calls.length).toBe(0);
    s1.release();

    const { target: t2, originals: o2 } = freshSyntheticTarget();
    const s2 = engage({ target: t2, policy: { allowUnixSocket: true } });
    const net2 = t2.net as { connect: (...a: unknown[]) => unknown };
    expect(() => net2.connect("/var/run/docker.sock")).not.toThrow();
    expect(o2.netConnect.calls.length).toBe(1);
    s2.release();
  });

  it("allowHosts admits only an exact host match", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowHosts: ["allowed.host"] } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("https://allowed.host/path")).not.toThrow();
    session.release();
  });

  it("allowHosts is exact — no suffix confusion (evilallowed.host / allowed.host.evil.com)", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowHosts: ["allowed.host"] } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("https://evilallowed.host/")).toThrow(AirgapViolationError);
    expect(() => fetchFn("https://allowed.host.evil.com/")).toThrow(AirgapViolationError);
    expect(() => fetchFn("https://sub.allowed.host/")).toThrow(AirgapViolationError);
    session.release();
  });

  it("allowHosts is case-insensitive without allowing a case-based bypass of a denial", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowHosts: ["Allowed.Host"] } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("https://ALLOWED.HOST/")).not.toThrow();
    expect(() => fetchFn("https://allowed.host/")).not.toThrow();
    expect(() => fetchFn("https://notallowed.host/")).toThrow(AirgapViolationError);
    session.release();
  });

  it("allowHosts resists the userinfo trick (http://evil@allowed.host/ actually targets allowed.host)", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowHosts: ["allowed.host"] } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    // userinfo in front of an ALLOWED host: genuinely targets allowed.host -> allowed.
    expect(() => fetchFn("http://evil@allowed.host/")).not.toThrow();
    // the inverse trick: userinfo carrying the allowed name in front of the REAL (disallowed) host must NOT bypass.
    expect(() => fetchFn("http://allowed.host@evil.com/")).toThrow(AirgapViolationError);
    session.release();
  });

  it("allowHosts never confuses an IP literal with the hostname it might resolve to", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { allowHosts: ["example.com"] } });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("https://93.184.216.34/")).toThrow(AirgapViolationError);
    session.release();
  });
});

// ---------------------------------------------------------------------------
// Restoration — airtight, idempotent, LIFO, survives a throw
// ---------------------------------------------------------------------------

describe("release() — restoration discipline", () => {
  it("restores every patched reference EXACTLY (===) after release", () => {
    const { target, originals } = freshSyntheticTarget();
    const http = target.http as Record<string, unknown>;
    const globals = target.globals as Record<string, unknown>;
    const session = engageAirgap({ target });
    expect(http.request).not.toBe(originals.httpRequest);
    expect(globals.fetch).not.toBe(originals.fetch);
    session.release();
    expect(http.request).toBe(originals.httpRequest);
    expect(http.get).toBe(originals.httpGet);
    expect(globals.fetch).toBe(originals.fetch);
  });

  it("double release() is a no-op", () => {
    const { target, originals } = freshSyntheticTarget();
    const globals = target.globals as Record<string, unknown>;
    const session = engageAirgap({ target });
    session.release();
    expect(globals.fetch).toBe(originals.fetch);
    expect(() => session.release()).not.toThrow();
    expect(globals.fetch).toBe(originals.fetch);
  });

  it("restores even when the guarded body rejects/throws (withAirgap)", async () => {
    const { target, originals } = freshSyntheticTarget();
    const globals = target.globals as Record<string, unknown>;
    await expect(
      withAirgap({ target }, async () => {
        expect(globals.fetch).not.toBe(originals.fetch);
        throw new Error("task exploded");
      }),
    ).rejects.toThrow("task exploded");
    expect(globals.fetch).toBe(originals.fetch);
  });

  it("nested withAirgap sessions restore in LIFO order (and compose cumulatively, never a looser inner policy overriding a stricter outer one)", async () => {
    const { target, originals } = freshSyntheticTarget();
    const globals = target.globals as Record<string, unknown>;

    await withAirgap({ target, policy: { allowHosts: ["shared.example"] } }, async () => {
      const outerFetch = globals.fetch;
      expect(outerFetch).not.toBe(originals.fetch);

      await withAirgap({ target, policy: { allowHosts: ["shared.example", "inner-only.example"] } }, async () => {
        const innerFetch = globals.fetch;
        expect(innerFetch).not.toBe(outerFetch);
        expect(innerFetch).not.toBe(originals.fetch);
        // a host both layers agree on passes through the whole stack.
        expect(() => (globals.fetch as (...a: unknown[]) => unknown)("https://shared.example")).not.toThrow();
        // a host only the INNER (looser) layer allows is still blocked, because the call must also
        // clear the OUTER (stricter) guard underneath it — nesting composes cumulatively, never loosens.
        expect(() => (globals.fetch as (...a: unknown[]) => unknown)("https://inner-only.example")).toThrow(AirgapViolationError);
      });

      // after the inner session releases, the OUTER guard (not the original) is restored
      expect(globals.fetch).toBe(outerFetch);
      expect(() => (globals.fetch as (...a: unknown[]) => unknown)("https://shared.example")).not.toThrow();
    });

    // after the outer session releases too, the true original is back
    expect(globals.fetch).toBe(originals.fetch);
  });

  it("the REAL globalThis.fetch is untouched after a real-runtime session releases", () => {
    const originalFetch = globalThis.fetch;
    const session = engageAirgap({});
    // Whatever it resolved to, calling it now must be a guard, not the original wired-through function.
    if (typeof originalFetch === "function") {
      expect(globalThis.fetch).not.toBe(originalFetch);
    }
    session.release();
    expect(globalThis.fetch).toBe(originalFetch);
  });
});

// ---------------------------------------------------------------------------
// Honesty — absent / unavailable / sealed
// ---------------------------------------------------------------------------

describe("honesty — absent vs unavailable vs sealed", () => {
  it("a target missing a seam entirely reports how: 'absent' and counts toward sealed", () => {
    const target: AirgapTarget = { globals: {} }; // no fetch, no http/https/net/dns/tls at all
    const session = engage({ target });
    const report = session.report();
    for (const status of report.seams) {
      expect(status.how).toBe("absent");
      expect(status.neutralized).toBe(true);
    }
    expect(report.sealed).toBe(true);
    expect(report.unverifiableSeams).toEqual([]);
    session.release();
  });

  it("a frozen (non-configurable, non-writable) property is reported unavailable and forces sealed:false", () => {
    const globals: { fetch?: unknown } = {};
    Object.defineProperty(globals, "fetch", {
      value: () => "real-fetch-would-run",
      writable: false,
      configurable: false,
      enumerable: true,
    });
    const target: AirgapTarget = { globals };
    const session = engage({ target, policy: { seams: ["fetch"] } });
    const report = session.report();
    expect(report.seams).toHaveLength(1);
    expect(report.seams[0]).toMatchObject({ seam: "fetch", how: "unavailable", neutralized: false });
    expect(report.unverifiableSeams).toEqual(["fetch"]);
    expect(report.sealed).toBe(false);
    // and, honestly, the frozen original is untouched and still callable — we did NOT pretend to have neutralized it.
    expect((globals.fetch as () => string)()).toBe("real-fetch-would-run");
    session.release();
  });

  it("NEVER reports sealed:true while any requested seam is unpatched", () => {
    const globals: { fetch?: unknown } = {};
    Object.defineProperty(globals, "fetch", { value: () => {}, writable: false, configurable: false });
    const { target: httpTarget } = freshSyntheticTarget();
    const target: AirgapTarget = { ...httpTarget, globals };
    const session = engage({ target, policy: { seams: ["fetch", "http"] } });
    const report = session.report();
    const fetchStatus = report.seams.find((s) => s.seam === "fetch")!;
    const httpStatus = report.seams.find((s) => s.seam === "http")!;
    expect(fetchStatus.neutralized).toBe(false);
    expect(httpStatus.neutralized).toBe(true);
    expect(report.sealed).toBe(false); // one bad seam poisons the whole report
    session.release();
  });

  it("a mixed http (request patchable, get missing) still reports the seam as patched overall", () => {
    const target: AirgapTarget = { globals: {}, http: { request: fakeFn("request") } };
    const session = engage({ target, policy: { seams: ["http"] } });
    const report = session.report();
    expect(report.seams[0]).toMatchObject({ seam: "http", how: "patched", neutralized: true });
    session.release();
  });

  it("policy.seams restricts which seams are engaged and reported", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target, policy: { seams: ["dns", "tls"] } });
    const report = session.report();
    expect(report.seams.map((s) => s.seam).sort()).toEqual(["dns", "tls"]);
    session.release();
  });

  it("ALL_EGRESS_SEAMS lists exactly the six locked seams", () => {
    expect([...ALL_EGRESS_SEAMS].sort()).toEqual(["dns", "fetch", "http", "https", "net-socket", "tls"]);
  });
});

// ---------------------------------------------------------------------------
// probeAirgap — dry, non-engaging
// ---------------------------------------------------------------------------

describe("probeAirgap", () => {
  it("reports the same neutralizability as engageAirgap would, without leaving anything patched", () => {
    const { target, originals } = freshSyntheticTarget();
    const globals = target.globals as Record<string, unknown>;
    const report = probeAirgap(target);
    expect(report.sealed).toBe(true);
    for (const s of report.seams) expect(s.how).toBe("patched");
    expect(report.attempts).toEqual([]);
    // nothing left engaged:
    expect(globals.fetch).toBe(originals.fetch);
  });

  it("probeAirgap against the real runtime restores the real fetch immediately", () => {
    const originalFetch = globalThis.fetch;
    const report = probeAirgap();
    expect(globalThis.fetch).toBe(originalFetch);
    expect(Array.isArray(report.seams)).toBe(true);
    expect(report.seams).toHaveLength(6);
  });

  it("probeAirgap reports unavailable/sealed:false honestly for a frozen target", () => {
    const globals: { fetch?: unknown } = {};
    Object.defineProperty(globals, "fetch", { value: () => {}, writable: false, configurable: false });
    const report = probeAirgap({ globals });
    const fetchStatus = report.seams.find((s) => s.seam === "fetch")!;
    expect(fetchStatus.how).toBe("unavailable");
    expect(report.sealed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onAttempt callback + attempts()/report() consistency
// ---------------------------------------------------------------------------

describe("attempt recording", () => {
  it("onAttempt fires for every attempt, blocked and allowed alike, and never breaks the guard if it throws", () => {
    const { target } = freshSyntheticTarget();
    const seen: EgressAttempt[] = [];
    const session = engage({
      target,
      policy: { allowHosts: ["ok.example"] },
      onAttempt: (a) => {
        seen.push(a);
        throw new Error("observer misbehaving");
      },
    });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    expect(() => fetchFn("https://ok.example")).not.toThrow();
    expect(() => fetchFn("https://blocked.example")).toThrow(AirgapViolationError);
    expect(seen).toHaveLength(2);
    expect(seen[0].blocked).toBe(false);
    expect(seen[1].blocked).toBe(true);
    session.release();
  });

  it("attempts() and report().attempts agree and are independent snapshots", () => {
    const { target } = freshSyntheticTarget();
    const session = engage({ target });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    try {
      fetchFn("https://a.example");
    } catch {
      /* expected */
    }
    const snap1 = session.attempts();
    expect(session.report().attempts).toEqual(snap1);
    try {
      fetchFn("https://b.example");
    } catch {
      /* expected */
    }
    expect(session.attempts()).toHaveLength(2);
    expect(snap1).toHaveLength(1); // the earlier snapshot did not grow
    session.release();
  });

  it("injected `now` is used for attempt timestamps", () => {
    const { target } = freshSyntheticTarget();
    let t = 1000;
    const session = engage({ target, now: () => t++ });
    const fetchFn = target.globals.fetch as (...a: unknown[]) => unknown;
    try {
      fetchFn("https://a.example");
    } catch {
      /* expected */
    }
    try {
      fetchFn("https://b.example");
    } catch {
      /* expected */
    }
    const attempts = session.attempts();
    expect(attempts[0].at).toBe(1000);
    expect(attempts[1].at).toBe(1001);
    session.release();
  });
});

describe("real-runtime engagement (default target)", () => {
  it("blocks a real global fetch call before any I/O and restores it after release", async () => {
    const originalFetch = globalThis.fetch;
    const spy = typeof originalFetch === "function" ? vi.fn(originalFetch) : undefined;
    if (spy) globalThis.fetch = spy as typeof fetch;

    const session = engageAirgap({});
    let threw: unknown;
    try {
      await globalThis.fetch("https://example.invalid/should-never-be-reached");
    } catch (err) {
      threw = err;
    }
    session.release();

    expect(threw).toBeInstanceOf(AirgapViolationError);
    if (spy) {
      expect(spy).not.toHaveBeenCalled();
      globalThis.fetch = originalFetch;
    }
  });
});
