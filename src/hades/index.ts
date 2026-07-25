/**
 * @module hades
 *
 * Hades — the fuller agent that wraps the Hermes-Swarm core with a closed
 * learning loop (durable cross-session memory, skills it creates from
 * experience, a model of the user), real messaging-platform connectors, extra
 * execution backends, the ACP protocol, research/training tooling, an
 * interactive REPL, and a plugin ecosystem. The swarm executes and verifies;
 * Hades remembers, learns, and lives where you do.
 */
export * from "./memory/index";
export * from "./learning/index";
export * from "./gateway/index";
export * from "./backends/index";
export * from "./acp/index";
export * from "./models/index";
export * from "./plugins/index";
export * from "./skill-packs/index";
export * from "./research/index";
export * from "./repl/index";
export * from "./cli/index";
export * from "./config/index";
export * from "./a2a/index";
export * from "./teams/index";
export * from "./modules/index";
export * from "./parallel/index";
export * from "./security/index";
export * from "./bench/index";
export * from "./hierarchy/index";
export * from "./metrics/index";
export * from "./agent/index";
export * from "./exec/index";
export * from "./tools/index";
export * from "./browser/index";
export * from "./styx/index";
export * from "./skills/index";
export * from "./mcp/index";
export * from "./schedule/index";
export * from "./state/index";
export * from "./migrate/index";
export * from "./trust/index";
