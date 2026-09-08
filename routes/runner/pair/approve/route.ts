/**
 * DROP THIS FILE INTO: your-app/src/app/api/runner/pair/approve/route.ts
 *
 * Device-code pairing, step 2. An authenticated user types the code shown on the machine and
 * approves (or denies) the scopes it asked for. This is the only step that confers authority.
 *
 * `grantedScopes` may only narrow the runner's request; `approvePairing` rejects any attempt
 * to grant something the machine did not ask for.
 */

import { z } from "zod";
import { auth } from "@/agents/auth";
import { ScopeSchema } from "@/agents/runner/protocol";
import { PairingError, approvePairing, denyPairing, getRunnerStore } from "@/agents/runner/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
	userCode: z.string().min(4).max(32),
	decision: z.enum(["approve", "deny"]).default("approve"),
	grantedScopes: z.array(ScopeSchema).default([]),
});

export async function POST(req: Request) {
	const user = await auth.requireAuth(req);

	const parsed = bodySchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return Response.json({ error: z.treeifyError(parsed.error) }, { status: 422 });
	}

	const { userCode, decision, grantedScopes } = parsed.data;
	const store = getRunnerStore();

	try {
		if (decision === "deny") {
			await denyPairing(userCode, store);
			return Response.json({ status: "denied" });
		}

		const runner = await approvePairing(userCode, user.id, grantedScopes, store);
		return Response.json({
			status: "approved",
			runner: {
				runnerId: runner.runnerId,
				os: runner.os,
				osVersion: runner.osVersion,
				arch: runner.arch,
				capVersion: runner.capVersion,
				grantedScopes: runner.grantedScopes,
				pairedAt: runner.pairedAt,
			},
		});
	} catch (err) {
		if (err instanceof PairingError) {
			return Response.json({ error: err.message, code: err.code }, { status: 400 });
		}
		throw err;
	}
}
