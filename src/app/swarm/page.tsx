"use client";

import { useEffect, useState } from "react";

/**
 * In-app entry point for the Hermes-Swarm control dashboard.
 *
 * The dashboard itself is served by the standalone `SwarmServer`
 * (`npm run swarm:dashboard`, default http://127.0.0.1:8080), which owns the
 * long-lived manager process and streams live state over SSE. This Next.js page
 * embeds that dashboard so the swarm is reachable from within the app shell,
 * and probes it so the user gets a clear "start the server" hint when it's down.
 */
export default function SwarmPage() {
  const defaultUrl =
    process.env.NEXT_PUBLIC_SWARM_DASHBOARD_URL ?? "http://127.0.0.1:8080";
  const [url, setUrl] = useState(defaultUrl);
  const [online, setOnline] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const res = await fetch(`${url}/api/state`, { mode: "cors" });
        if (!cancelled) setOnline(res.ok);
      } catch {
        if (!cancelled) setOnline(false);
      }
    };
    probe();
    const t = setInterval(probe, 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [url]);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 0, margin: 0, height: "100vh", display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid #e5e7eb" }}>
        <strong style={{ letterSpacing: 0.5 }}>🐝 Hermes-Swarm</strong>
        <span
          style={{
            fontSize: 12,
            padding: "2px 8px",
            borderRadius: 6,
            background: online ? "#dcfce7" : online === false ? "#fee2e2" : "#f3f4f6",
            color: online ? "#166534" : online === false ? "#991b1b" : "#6b7280",
          }}
        >
          {online == null ? "checking…" : online ? "dashboard online" : "dashboard offline"}
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          style={{ marginLeft: "auto", width: 320, padding: "4px 8px", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 13 }}
        />
        <a href={url} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
          open ↗
        </a>
      </div>

      {online ? (
        <iframe title="Hermes-Swarm dashboard" src={url} style={{ flex: 1, border: 0, width: "100%" }} />
      ) : (
        <div style={{ padding: 32, color: "#374151", lineHeight: 1.6 }}>
          <h2>Start the swarm dashboard</h2>
          <p>The control server isn&apos;t reachable at <code>{url}</code>. Launch it with:</p>
          <pre style={{ background: "#0b0e14", color: "#e6e9ef", padding: 16, borderRadius: 8, overflowX: "auto" }}>
{`# from the repo root
npm run swarm:dashboard            # inline mode (no Docker)
# or a full container swarm:
docker compose -f docker-compose.swarm.yml up --build`}
          </pre>
          <p>Then reload this page. See <code>ARCHITECTURE.md</code> for the full design.</p>
        </div>
      )}
    </main>
  );
}
