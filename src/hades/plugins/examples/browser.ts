import type { HadesPlugin, PluginContext } from "../plugin";

/**
 * Browser plugin — registers a `browser` skill (capability `browse` + a prompt
 * fragment) so any worker can be granted web-reading competence, and counts
 * browse tool calls via the `tool:after` hook. A minimal example of a plugin
 * that extends both host services (skills) and observes runtime hooks.
 */
export class BrowserPlugin implements HadesPlugin {
  readonly name = "browser";
  readonly description = "Adds a web-browsing skill and tracks page fetches";
  visited: string[] = [];

  register(ctx: PluginContext): void {
    ctx.addSkill({
      name: "browser",
      description: "Fetch and read web pages",
      capabilities: ["browse"],
      promptFragment: "You can browse the web: fetch a URL and read its text before answering.",
    });
    ctx.on("tool:after", (p) => {
      if (p.tool !== "browse" || !p.ok) return;
      const url = (p.output as { url?: string } | undefined)?.url;
      if (url) this.visited.push(url);
    });
  }
}
