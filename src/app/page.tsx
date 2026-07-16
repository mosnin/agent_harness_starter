"use client";

import Link from "next/link";
import DecryptedText from "./components/DecryptedText";

const cards = [
  {
    k: "Provable trust",
    t: "Abstention by default",
    d: "A conformal gate bounds the silent-wrong rate to a number you set. The swarm delivers a verified answer or it declines. It never guesses out loud.",
  },
  {
    k: "Verified work per dollar",
    t: "Cheap swarm, strong verifier",
    d: "Many small workers race divergent plans. A calibrated verifier ensemble picks the winner, so you buy correctness at a fraction of a single frontier model.",
  },
  {
    k: "Proof carrying",
    t: "Every result is signed",
    d: "Each accepted answer ships an ed25519 certificate binding the output, the score, the tier, and a replayable trace. Trust you can hand to an auditor.",
  },
];

export default function HomePage() {
  return (
    <main style={{ maxWidth: 1120, margin: "0 auto", padding: "0 var(--s3)" }}>
      <section
        style={{
          minHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: "var(--s3)",
        }}
      >
        <span
          className="rise"
          style={{
            fontSize: "var(--fs-xs)",
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--accent)",
            fontWeight: 600,
          }}
        >
          Hades
        </span>

        <h1 className="rise rise-1" style={{ fontSize: "var(--fs-hero)", margin: 0, fontWeight: 620 }}>
          <span style={{ display: "block" }}>
            <DecryptedText
              text="Agent swarms"
              animateOn="view"
              sequential
              speed={38}
              className="dt-on"
              encryptedClassName="dt-off"
            />
          </span>
          <span style={{ display: "block", color: "var(--accent)" }}>
            <DecryptedText
              text="you can trust."
              animateOn="view"
              sequential
              speed={38}
              className="dt-on"
              encryptedClassName="dt-off"
            />
          </span>
        </h1>

        <p
          className="rise rise-2"
          style={{
            fontSize: "var(--fs-h2)",
            color: "var(--ink-soft)",
            maxWidth: 620,
            margin: 0,
            lineHeight: 1.5,
            fontWeight: 400,
          }}
        >
          A verification first swarm. Speculate, verify, and prove. Ship correct,
          auditable work per dollar, not a confident guess.
        </p>

        <div className="rise rise-3" style={{ display: "flex", gap: "var(--s2)", marginTop: "var(--s1)", flexWrap: "wrap" }}>
          <Link
            href="/swarm"
            style={{
              background: "var(--ink)",
              color: "#fff",
              padding: "14px 26px",
              borderRadius: 999,
              textDecoration: "none",
              fontWeight: 560,
              fontSize: "var(--fs-sm)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            Open the control room
          </Link>
          <a
            href="https://github.com"
            style={{
              color: "var(--ink)",
              padding: "14px 22px",
              borderRadius: 999,
              textDecoration: "none",
              fontWeight: 520,
              fontSize: "var(--fs-sm)",
              background: "var(--surface)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            Read the architecture
          </a>
        </div>
      </section>

      <section
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "var(--s3)",
          paddingBottom: "var(--s6)",
        }}
      >
        {cards.map((c, i) => (
          <article
            key={c.k}
            className={`rise rise-${i + 1}`}
            style={{
              background: "var(--surface)",
              borderRadius: "var(--radius)",
              padding: "var(--s4) var(--s3)",
              boxShadow: "var(--shadow-sm)",
            }}
          >
            <div
              style={{
                fontSize: "var(--fs-xs)",
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "var(--accent)",
                fontWeight: 600,
                marginBottom: "var(--s2)",
              }}
            >
              {c.k}
            </div>
            <h3 style={{ fontSize: "var(--fs-h2)", margin: "0 0 var(--s2)" }}>{c.t}</h3>
            <p style={{ color: "var(--ink-soft)", margin: 0, fontSize: "var(--fs-sm)", lineHeight: 1.6 }}>
              {c.d}
            </p>
          </article>
        ))}
      </section>
    </main>
  );
}
