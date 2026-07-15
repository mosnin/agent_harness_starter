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
