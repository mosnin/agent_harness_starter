import type { DatabaseSync } from "node:sqlite";
import { decodeHelmOrcaUsage } from "./helm-orca-usage";

type Available = Extract<
  ReturnType<typeof decodeHelmOrcaUsage>,
  { state: "available" }
>;

/** Retains observations, never a settled charge. Caller owns the intent transaction. */
export class HelmOrcaUsageStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_observations (
      intent_id TEXT NOT NULL, observation_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
      observed_at INTEGER NOT NULL, payload TEXT NOT NULL, reported_conflict INTEGER NOT NULL,
      PRIMARY KEY(intent_id, observation_key, payload_hash));`);
  }
  retain(intentId: string, page: Available) {
    const insert = this.db.prepare(`INSERT INTO usage_observations
      (intent_id,observation_key,payload_hash,observed_at,payload,reported_conflict)
      VALUES (?,?,?,?,?,?) ON CONFLICT(intent_id,observation_key,payload_hash)
      DO UPDATE SET reported_conflict=MAX(reported_conflict,excluded.reported_conflict)`);
    for (const row of page.observations)
      insert.run(
        intentId,
        row.observationKey,
        row.payloadHash,
        row.observedAt,
        JSON.stringify(row),
        row.conflict ? 1 : 0,
      );
  }
  read(
    intentId: string,
    expected: { dispatchId: string; sessionId: string },
    offset = 0,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new Error("Invalid usage offset");
    const rows = this.db
      .prepare(
        `SELECT payload,reported_conflict,
      (SELECT COUNT(*) FROM usage_observations v WHERE v.intent_id=u.intent_id
       AND v.observation_key=u.observation_key) AS variants
      FROM usage_observations u WHERE intent_id=?
      ORDER BY observed_at,observation_key,payload_hash LIMIT 101 OFFSET ?`,
      )
      .all(intentId, offset) as Array<{
      payload: string;
      reported_conflict: number;
      variants: number;
    }>;
    const conflict = !!this.db
      .prepare(
        `SELECT 1 FROM usage_observations WHERE intent_id=?
      GROUP BY observation_key HAVING COUNT(*)>1 OR MAX(reported_conflict)=1 LIMIT 1`,
      )
      .get(intentId);
    const decoded = decodeHelmOrcaUsage(
      {
        version: 1,
        state: "available",
        ...expected,
        aggregation: "unknown",
        observations: rows.slice(0, 100).map((row) => ({
          ...JSON.parse(row.payload),
          conflict: row.reported_conflict === 1 || row.variants > 1,
        })),
        conflict,
        truncated: rows.length > 100,
      },
      expected,
    );
    if (decoded.state !== "available")
      throw new Error("Corrupt retained Orca usage evidence");
    return {
      ...decoded,
      offset,
      nextOffset: rows.length > 100 ? offset + 100 : null,
    };
  }
}
