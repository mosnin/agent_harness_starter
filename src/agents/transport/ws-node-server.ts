/**
 * Standalone WebSocket gateway process.
 *
 * Next.js App Router routes cannot host a WebSocket server, so the runner does not dial the
 * Next app — it dials this process, which owns the sockets and drives a `SessionMultiplexer`.
 * Everything above the socket lives in `transport/multiplexer.ts` and `runner/gateway.ts`,
 * which are transport-free and unit-tested with fake sockets.
 *
 * Deployment:
 *   npm run runner:gateway            # binds RUNNER_GATEWAY_PORT (default 8787)
 *
 * Run it as its own long-lived service (fly.io machine, ECS task, systemd unit) — not on a
 * serverless platform, which will not hold a socket open for a minutes-long recording. Put it
 * behind TLS; the runner connects to `wss://…/runner` and presents its pairing bearer token.
 *
 * The Next app and this process must share a `RunnerStore` (see `runner/registry.ts`) for
 * pairing and session state to be visible to both. With the in-memory default they are two
 * separate worlds; install a Postgres/Redis store before splitting the processes.
 */

import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { getRunnerStore, touchRunner } from "../runner/registry";
import { SessionMultiplexer } from "./multiplexer";
import type { RunnerSocket, TransportLogger } from "./types";

export interface GatewayServerOptions {
	port?: number;
	host?: string;
	path?: string;
	/** Verify the bearer token a runner presents on connect. Reject with false. */
	authenticate?: (req: { headers: Record<string, string | string[] | undefined> }) => Promise<boolean> | boolean;
	sweepIntervalMs?: number;
	logger?: TransportLogger;
	mux?: SessionMultiplexer;
}

const consoleLogger: TransportLogger = (level, message, meta) => {
	process.stdout.write(
		`${JSON.stringify({ level, message, ...meta, at: new Date().toISOString() })}\n`,
	);
};

function toRunnerSocket(ws: WebSocket): RunnerSocket {
	return {
		send(frame: string) {
			if (ws.readyState === ws.OPEN) ws.send(frame);
		},
		close(code?: number, reason?: string) {
			try {
				ws.close(code ?? 1000, reason);
			} catch {
				ws.terminate();
			}
		},
	};
}

export interface RunningGateway {
	mux: SessionMultiplexer;
	port: number;
	close(): Promise<void>;
}

export async function startGatewayServer(
	options: GatewayServerOptions = {},
): Promise<RunningGateway> {
	const logger = options.logger ?? consoleLogger;
	const port = options.port ?? Number(process.env.RUNNER_GATEWAY_PORT ?? 8787);
	const host = options.host ?? process.env.RUNNER_GATEWAY_HOST ?? "0.0.0.0";
	const path = options.path ?? "/runner";
	const mux = options.mux ?? new SessionMultiplexer({ logger });
	const store = getRunnerStore();

	const httpServer = createServer((req, res) => {
		if (req.url === "/healthz") {
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ ok: true, connections: mux.listConnections().length }));
			return;
		}
		res.writeHead(426, { "Content-Type": "text/plain" });
		res.end("Upgrade required");
	});

	const wss = new WebSocketServer({ server: httpServer, path });

	wss.on("connection", async (ws, req) => {
		if (options.authenticate) {
			const ok = await options.authenticate({ headers: req.headers });
			if (!ok) {
				logger("warn", "Rejected unauthenticated runner connection");
				ws.close(4401, "Unauthenticated");
				return;
			}
		}

		const attached = mux.attach(toRunnerSocket(ws));

		ws.on("message", (data) => attached.receive(data.toString()));
		ws.on("close", () => attached.disconnected("WebSocket closed."));
		ws.on("error", (err) => attached.disconnected(err.message));

		try {
			const runnerId = await attached.ready;
			logger("info", "Runner connected", { runnerId });
			await touchRunner(runnerId, store);
		} catch (err) {
			logger("warn", "Runner handshake failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
	});

	const sweep = setInterval(() => {
		const closed = mux.sweepIdle();
		if (closed > 0) logger("warn", "Closed idle runner connections", { closed });
	}, options.sweepIntervalMs ?? 15_000);
	if (typeof sweep === "object" && sweep !== null && "unref" in sweep) sweep.unref();

	await new Promise<void>((resolve) => httpServer.listen(port, host, resolve));
	logger("info", "Runner gateway listening", { host, port, path });

	return {
		mux,
		port,
		async close() {
			clearInterval(sweep);
			mux.closeAll("Gateway shutting down.");
			await new Promise<void>((resolve) => wss.close(() => resolve()));
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}

const isEntrypoint =
	typeof process !== "undefined" &&
	Boolean(process.argv[1]) &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isEntrypoint) {
	startGatewayServer().catch((err) => {
		process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
		process.exit(1);
	});
}
