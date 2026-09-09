/**
 * @module @/agents/transport
 *
 * Transport for runner connections. `SessionMultiplexer` owns no sockets — the socket layer is
 * injected — so correlation, timeouts and event fan-out are testable without a live connection.
 * The Node WebSocket server entry point is deliberately not re-exported here: it pulls in `ws`
 * and is run as its own process, not imported by the Next.js app.
 */

export * from "./types";
export * from "./multiplexer";
export * from "./sse";
