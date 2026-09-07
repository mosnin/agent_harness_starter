/** Always-on team service. Bootstrap credentials are local, never an HTTP route. */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { TeamStore } from "./store";
import { TeamServer } from "./server";
export async function teamMain(argv: string[]) {
  const [command, ...args] = argv;
  const options: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--data-dir", "--name", "--owner", "--port"].includes(args[i]) || !args[i + 1]) throw new Error("Use named options: --data-dir, --name, --owner, --port.");
    options[args[i].slice(2)] = args[i + 1];
  }
  if (!["init", "serve", "invite"].includes(command)) { process.stdout.write("Hades team service (Node 22.13+)\n  init --data-dir DIR --name TEAM --owner NAME\n  serve --data-dir DIR --port 18770\n  invite --data-dir DIR\nExpose serve through an HTTPS reverse proxy for other Macs.\n"); return; }
  if (!options["data-dir"]) throw new Error("Choose --data-dir explicitly. Keep this folder private and backed up.");
  const dir = resolve(options["data-dir"]); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new TeamStore(join(dir, "team.sqlite"));
  const ownerPath = join(dir, "owner.json");
  if (command === "serve") {
    if (!store.initialized()) { store.close(); throw new Error("Initialize this team before serving it."); }
    const port = Number(options.port ?? 18770);
    if (!Number.isInteger(port) || port < 1 || port > 65535) { store.close(); throw new Error("Port must be between 1 and 65535."); }
    const server = new TeamServer(store);
    try { const address = await server.listen(port); process.stdout.write(`Hades team service listening at ${address}. Remote access requires an HTTPS reverse proxy.\n`); }
    catch (error) { store.close(); throw error; }
    let stopping = false;
    const stop = () => { if (stopping) return; stopping = true; void server.close().finally(() => { store.close(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }); };
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    return;
  }
  try {
    if (command === "init") {
      if (existsSync(ownerPath)) throw new Error("Owner credentials already exist. Use a different data directory for another team.");
      const result = store.create(options.name, options.owner);
      writeFileSync(ownerPath, JSON.stringify({ token: result.token }), { mode: 0o600, flag: "wx" });
      process.stdout.write("Team initialized. Owner credentials are stored in owner.json with private file permissions. Run invite to add desktop members.\n");
    } else {
      const token = JSON.parse(readFileSync(ownerPath, "utf8")).token;
      const invitation = store.invite(store.authenticate(token));
      process.stdout.write(JSON.stringify(invitation) + "\n");
    }
  } finally { store.close(); }
}
if (/[/\\]team-server\.(js|ts)$/.test(process.argv[1] ?? "")) void teamMain(process.argv.slice(2)).catch(error => { process.stderr.write((error instanceof Error ? error.message : "Team service failed") + "\n"); process.exitCode = 1; });
