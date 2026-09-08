/**
 * DROP THIS FILE INTO: your-app/src/app/api/runner/pair/token/route.ts
 *
 * Device-code pairing, step 3. The runner polls with its device code until a user approves.
 * An approved request is marked `claimed` on first redemption, so a leaked device code cannot
 * be redeemed a second time.
 */

import { z } from "zod";
import { PairingError, claimPairing, getRunnerStore } from "@/agents/runner/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
	deviceCode: z.string().min(16).max(256),
});

export async function POST(req: Request) {
	const parsed = bodySchema.safeParse(await req.json().catch(() => null));
	if (!parsed.success) {
		return Response.json({ error: z.treeifyError(parsed.error) }, { status: 422 });
	}

	try {
		const result = await claimPairing(parsed.data.deviceCode, getRunnerStore());

		if (result.status === "approved") {
			return Response.json(
				{
					status: "approved",
					runnerId: result.runner.runnerId,
					grantedScopes: result.runner.grantedScopes,
				},
				{ headers: { "Cache-Control": "no-store" } },
			);
		}

		return Response.json(result, {
			status: result.status === "pending" ? 202 : 400,
			headers: { "Cache-Control": "no-store" },
		});
	} catch (err) {
		if (err instanceof PairingError) {
			return Response.json({ error: err.message, code: err.code }, { status: 400 });
		}
		throw err;
	}
}
