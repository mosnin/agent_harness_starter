import type { HadesPlugin, PluginContext } from "../plugin";

export type KanbanColumn = "todo" | "in_progress" | "done";

export interface KanbanCard {
  id: string;
  title: string;
  column: KanbanColumn;
}

/**
 * Kanban plugin — mirrors goals onto a board. `goal:start` creates an
 * in-progress card; `goal:complete` moves it to done (or back to todo if the
 * goal didn't complete cleanly). Example of a stateful plugin a GUI can render.
 */
export class KanbanPlugin implements HadesPlugin {
  readonly name = "kanban";
  readonly description = "Mirrors goals onto a kanban board";
  private cards = new Map<string, KanbanCard>();

  private keyFor(p: { goalId?: string; objective: string }): string {
    return p.goalId ?? p.objective;
  }

  register(ctx: PluginContext): void {
    ctx.on("goal:start", (p) => {
      const id = this.keyFor(p);
      this.cards.set(id, { id, title: p.objective, column: "in_progress" });
    });
    ctx.on("goal:complete", (p) => {
      const id = this.keyFor(p);
      const card = this.cards.get(id) ?? { id, title: p.objective, column: "todo" as KanbanColumn };
      card.column = p.status === "completed" ? "done" : "todo";
      this.cards.set(id, card);
    });
  }

  board(): KanbanCard[] {
    return [...this.cards.values()];
  }
  column(col: KanbanColumn): KanbanCard[] {
    return this.board().filter((c) => c.column === col);
  }
}
