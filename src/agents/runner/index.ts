/**
 * @module @/agents/runner
 *
 * The control-plane half of desktop agent control: the Director Protocol mirror, the runner
 * registry and pairing flow, the gateway that authorizes every command against a session lease,
 * and the resumable run stream that carries minutes-long progress back to a client.
 */

export * from "./protocol";
export * from "./registry";
export * from "./gateway";
export * from "./scopes";
export * from "./stream";
export * from "./progress-plugin";
