/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/v1/auth/sign-out/route.ts
 *
 * Sign-out is client-driven — the browser discards its tokens. This endpoint
 * exists so a deployment keeping a revocation list has somewhere to hook one in.
 */
import { handleSignOut } from "@/agents/hades/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return handleSignOut();
}
