import type { HadesPlugin, PluginContext } from "../plugin";

export interface Achievement {
  id: string;
  title: string;
  unlockedAt: number;
}

interface AchievementDef {
  id: string;
  title: string;
  atGoals: number;
}

const DEFS: AchievementDef[] = [
  { id: "first-goal", title: "First Goal", atGoals: 1 },
  { id: "five-goals", title: "Five Goals", atGoals: 5 },
  { id: "ten-goals", title: "Getting Serious", atGoals: 10 },
];

/**
 * Achievements plugin — a gamification example. Counts completed goals and
 * unlocks milestones. Pure observation via the `goal:complete` hook; exposes
 * `unlocked` for a GUI badge shelf.
 */
export class AchievementsPlugin implements HadesPlugin {
  readonly name = "achievements";
  readonly description = "Unlocks achievements as goals complete";
  goalsCompleted = 0;
  readonly unlocked: Achievement[] = [];

  constructor(private readonly now: () => number = () => Date.now()) {}

  register(ctx: PluginContext): void {
    ctx.on("goal:complete", (p) => {
      if (p.status !== "completed") return;
      this.goalsCompleted++;
      for (const def of DEFS) {
        if (this.goalsCompleted >= def.atGoals && !this.unlocked.some((u) => u.id === def.id)) {
          this.unlocked.push({ id: def.id, title: def.title, unlockedAt: this.now() });
          ctx.log(`🏆 unlocked: ${def.title}`);
        }
      }
    });
  }
}
