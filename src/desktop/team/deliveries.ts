import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
export interface TeamDelivery { id: string; teamId: string; requestHash: string; endpoint: string; channel: string; profile: string; session: string; replyTo: string; status: "running" | "ready" | "sent" | "failed"; error?: string; }
export class TeamDeliveries {
  private rows: TeamDelivery[];
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "deliveries.json"); this.rows = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
    for (const row of this.rows) if (row.status === "running") { row.status = "failed"; row.error = "Hades restarted before this agent finished. Open the conversation to continue."; }
    this.save();
  }
  all() { return this.rows.map(row => ({ ...row })); }
  get(id: string) { const row = this.rows.find(row => row.id === id); if (!row) throw new Error("Team delivery not found"); return row; }
  add(row: TeamDelivery) { this.rows.push(row); this.save(); }
  update(id: string, patch: Partial<TeamDelivery>) { Object.assign(this.get(id), patch); this.save(); }
  private save() { const path = join(this.dir, "deliveries.json"); writeFileSync(path + ".tmp", JSON.stringify(this.rows), { mode: 0o600 }); renameSync(path + ".tmp", path); }
}
