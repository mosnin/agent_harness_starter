/**
 * DROP THIS FILE INTO: your-app/src/app/api/runner/route.ts
 *
 * GET    — list the machines paired to the signed-in user.
 * DELETE — revoke a pairing (?runnerId=…). Revocation zeroes the granted scopes, so any later
 *          session start fails closed even if the daemon is still connected.
 */

import { auth } from "@/agents/auth";
import { getRunnerStore, revokeRunner } from "@/agents/runner/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const user = await auth.requireAuth(req);
	const runners = await getRunnerStore().listRunners(user.id);

	return Response.json({
		runners: runners.map((r) => ({
			runnerId: r.runnerId,
			os: r.os,
			osVersion: r.osVersion,
			arch: r.arch,
			capVersion: r.capVersion,
			protocolVersion: r.protocolVersion,
			grantedScopes: r.grantedScopes,
			pairedAt: r.pairedAt,
			lastSeenAt: r.lastSeenAt,
			revokedAt: r.revokedAt ?? null,
		})),
	});
}

export async function DELETE(req: Request) {
	const user = await auth.requireAuth(req);
	const runnerId = new URL(req.url).searchParams.get("runnerId");
	if (!runnerId) {
		return Response.json({ error: "runnerId is required" }, { status: 400 });
	}

	const store = getRunnerStore();
	const runner = await store.getRunner(runnerId);
	if (!runner || runner.userId !== user.id) {
		return Response.json({ error: "Runner not found" }, { status: 404 });
	}

	await revokeRunner(runnerId, store);
	return Response.json({ status: "revoked", runnerId });
}
