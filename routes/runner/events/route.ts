/**
 * DROP THIS FILE INTO: your-app/src/app/api/runner/events/route.ts
 *
 * GET /api/runner/events?sessionId=… — resumable SSE stream of runner progress for one session.
 *
 * A recording session runs for minutes, longer than an HTTP connection reliably survives, so
 * every frame carries an `id:` and the client may reconnect with `Last-Event-ID` to replay
 * from where it dropped (see `runner/stream.ts` for the retained buffer).
 *
 * Requires the gateway to be running in THIS process (`setRunnerGateway`). In the split
 * deployment — Next app here, WebSocket gateway in its own process — this route returns 503
 * until a shared, cross-process event bus is installed.
 */

import { auth } from "@/agents/auth";
import { getRunnerGateway } from "@/agents/runner/gateway";
import { getRunnerStore } from "@/agents/runner/registry";
import { parseLastEventId } from "@/agents/runner/stream";
import { sseEventStream } from "@/agents/transport/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const user = await auth.requireAuth(req);
	const sessionId = new URL(req.url).searchParams.get("sessionId");
	if (!sessionId) {
		return Response.json({ error: "sessionId is required" }, { status: 400 });
	}

	const session = await getRunnerStore().getSession(sessionId);
	if (!session || session.userId !== user.id) {
		return Response.json({ error: "Session not found" }, { status: 404 });
	}

	const gateway = getRunnerGateway();
	if (!gateway) {
		return Response.json(
			{
				error: "No runner gateway in this process.",
				remediation:
					"Run the gateway in-process via setRunnerGateway(), or install a shared event bus.",
			},
			{ status: 503 },
		);
	}

	const after = parseLastEventId(req.headers.get("Last-Event-ID"));
	const stream = gateway.stream(sessionId);

	async function* events() {
		for await (const { seq, event } of stream.subscribe(after, req.signal)) {
			yield { seq, sessionId, runId: session?.runId, ...event };
		}
	}

	return new Response(sseEventStream(events(), { withIds: true, startSeq: after + 1 }), {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Session-Id": sessionId,
		},
	});
}
