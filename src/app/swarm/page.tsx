"use client";

import { useEffect, useState } from "react";
import DecryptedText from "../components/DecryptedText";

/**
 * In-app entry point for the Hermes-Swarm control room. The dashboard is served
 * by the standalone SwarmServer; this page embeds it and, when it is not yet
 * reachable, shows a calm waiting state rather than exposing the plumbing.
 */
export default function SwarmPage() {
  const defaultUrl = process.env.NEXT_PUBLIC_SWARM_DASHBOARD_URL ?? "http://127.0.0.1:8080";
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

  const dot = online ? "var(--ok)" : online === false ? "var(--ink-faint)" : "var(--warn)";
  const label = online == null ? "connecting" : online ? "live" : "waiting for the swarm";

  return (
    <main style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s2)",
          padding: "16px var(--s3)",
          background: "var(--surface)",
          boxShadow: "var(--shadow-sm)",
          zIndex: 2,
        }}
      >
        <strong style={{ fontSize: "var(--fs-sm)", letterSpacing: "-0.01em" }}>
          <DecryptedText text="Hermes Swarm" animateOn="view" sequential speed={34} className="dt-on" encryptedClassName="dt-off" />
        </strong>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 7,
            fontSize: "var(--fs-xs)",
            color: "var(--ink-soft)",
            fontWeight: 500,
          }}
        >
          <span style={{ width: 8, height: 8, borderRadius: 999, background: dot, boxShadow: online ? "0 0 10px var(--ok)" : "none" }} />
          {label}
        </span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
          style={{
            marginLeft: "auto",
            width: 300,
            padding: "8px 12px",
            border: "none",
            background: "var(--bg)",
            borderRadius: 999,
            fontSize: "var(--fs-xs)",
            color: "var(--ink)",
            outline: "none",
          }}
        />
      </header>

      {online ? (
        <iframe title="Hermes-Swarm control room" src={url} style={{ flex: 1, border: 0, width: "100%" }} />
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--s3)",
            padding: "var(--s4)",
            textAlign: "center",
          }}
        >
          <div style={{ position: "relative", width: 72, height: 72 }}>
            <span
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: 999,
                background: "var(--accent-soft)",
                animation: "pulse 2.2s var(--ease) infinite",
              }}
            />
            <span
              style={{
                position: "absolute",
                inset: 20,
                borderRadius: 999,
                background: "var(--accent)",
              }}
            />
          </div>
          <h2 className="rise" style={{ fontSize: "var(--fs-h1)", margin: 0 }}>
            Waiting for the swarm
          </h2>
          <p className="rise rise-1" style={{ color: "var(--ink-soft)", maxWidth: 460, margin: 0, fontSize: "var(--fs-sm)" }}>
            The control room connects the moment your swarm is up. This page will
            come alive on its own. No need to refresh.
          </p>
          <a
            className="rise rise-2"
            href={url}
            target="_blank"
            rel="noreferrer"
            style={{
              marginTop: "var(--s1)",
              background: "var(--ink)",
              color: "#fff",
              padding: "12px 22px",
              borderRadius: 999,
              textDecoration: "none",
              fontWeight: 540,
              fontSize: "var(--fs-sm)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            Open in a new tab
          </a>
          <style>{`@keyframes pulse { 0%,100% { transform: scale(1); opacity: 0.55 } 50% { transform: scale(1.35); opacity: 0.15 } }`}</style>
        </div>
      )}
    </main>
  );
}
