/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/v1/auth/sign-in/route.ts
 *
 * Point the browser at this deployment with
 * HADES_API_BASE=https://your-app.example/api/hades
 */
import { handleSignIn } from "@/agents/hades/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleSignIn(req);
}
