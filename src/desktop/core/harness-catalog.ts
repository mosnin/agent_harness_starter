/** Every canonical command in HadesCli.run is represented here. */
export const harnessCatalog = [
  ["chat", "Conversations", "Interactive agent with workspace tools and history", "Agent"],
  ["model", "Models", "Catalog, selection and provider routing", "Agent"],
  ["memory", "Memory", "Recall, search, timelines and write guards", "Agent"],
  ["profile", "User profiles", "Preferences and dialectic user modeling", "Agent"],
  ["skills", "Skill library", "Skill packs and hub management", "Agent"],
  ["skill", "Skill evolution", "Create, validate, synthesize, refine and evaluate skills", "Agent"],
  ["plugins", "Plugins", "Plugin registry and lifecycle", "Agent"],
  ["tools", "Tools", "Catalog and enable or disable tools", "Agent"],
  ["learn", "Learning", "Trajectory recording and learning workflows", "Agent"],
  ["exec", "Program execution", "JavaScript and Python tool programs", "Workspace"],
  ["browser", "Browser automation", "Chromium browsing and trace verification", "Workspace"],
  ["state", "Shared state", "CRDT workspace journal, sync and recovery", "Workspace"],
  ["schedule", "Scheduler", "Cron, persistent jobs and verified delivery receipts", "Workspace"],
  ["gateway", "Messaging", "Multi-platform gateway, pairing and delivery", "Workspace"],
  ["team", "Agent teams", "Roles and team formation", "Orchestration"],
  ["hierarchy", "Hierarchies", "Manager and worker execution trees", "Orchestration"],
  ["backends", "Computers", "Local, Docker and remote compute lifecycle", "Orchestration"],
  ["cluster", "Clusters", "Multi-node coordination and recovery", "Orchestration"],
  ["route", "Model routing", "Budget-aware routing and measured cost", "Orchestration"],
  ["trust", "Trust", "STYX verification, calibration and budgets", "Verification"],
  ["gov", "Governance", "Identity, policy, audit and air-gap controls", "Verification"],
  ["market", "Work market", "Reputation, certificates and settlement", "Verification"],
  ["eval", "Evaluations", "Evaluation runs, gates and regression bisection", "Verification"],
  ["dataset", "Datasets", "Export, verify and fine-tuning preparation", "Verification"],
  ["bench", "Benchmarks", "Measured harness benchmarks", "Verification"],
  ["showdown", "Comparisons", "Live and explicitly synthetic comparison modes", "Verification"],
  ["tui", "Terminal interface", "The full interactive Hades TUI", "System"],
  ["migrate", "Migration", "Import Hermes and OpenClaw with rollback receipts", "System"],
  ["install", "Install tools", "Package verification and installation diagnostics", "System"],
  ["setup", "Setup", "Configuration and machine readiness", "System"],
  ["doctor", "Diagnostics", "Read-only readiness checks", "System"],
  ["update", "Updates", "Published version and upgrade instructions", "System"],
  ["version", "Version", "Installed harness version", "System"],
  ["help", "Help", "Complete CLI help and command reference", "System"],
].map(([command, name, description, group]) => ({ command, name, description, group }));
export function parseHarnessArgs(command: unknown, input: unknown): string[] {
  if (!harnessCatalog.some(item => item.command === command)) throw new Error("Unknown harness command");
  if (typeof input !== "string" || input.length > 8000) throw new Error("Arguments are too long");
  // Accept a JSON argv array. No shell substitutions, redirections or quoting ambiguity.
  const args: unknown = JSON.parse(input || "[]");
  if (!Array.isArray(args) || args.length > 100 || args.some(a => typeof a !== "string" || a.includes("\0") || a.includes("\n") || a.length > 4000)) throw new Error("Use a JSON array of command arguments.");
  return [String(command), ...args as string[]];
}
export const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
