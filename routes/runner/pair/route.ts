/**
 * DROP THIS FILE INTO: your-app/src/app/api/runner/pair/route.ts
 *
 * Device-code pairing, step 1. The cap-runner daemon posts its identity and the scopes it
 * wants; it then displays the returned `userCode` for the user to type into Hades.
 *
 * Unauthenticated by design — the machine has no Hades session yet. Authority comes from a
 * human approving the code in step 2, never from this call.
 */

import { z } from "zod";
import { ScopeSchema } from "@/agents/runner/protocol";
import { getRunnerStore, startPairing } from "@/agents/runner/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
	runnerId: z.string().min(1).max(200),
	publicKey: z.string().min(1).max(4096),
	os: z.string().min(1).max(64),
	osVersion: z.string().min(1).max(64),
	arch: z.string().min(1).max(32),
	capVersion: z.string().min(1).max(64),
	protocolVersion: z.string().min(1).max(32),
	requestedScopes: z.array(ScopeSchema).min(1),
});

export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return Response.json({ error: z.treeifyError(parsed.error) }, { status: 422 });
	}

	const { requestedScopes, ...identity } = parsed.data;
	const result = await startPairing(identity, requestedScopes, getRunnerStore());

	return Response.json(
		{
			userCode: result.userCode,
			deviceCode: result.deviceCode,
			expiresAt: result.expiresAt,
			pollIntervalSec: result.pollIntervalSec,
		},
		{ status: 201, headers: { "Cache-Control": "no-store" } },
	);
}
