/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/v1/auth/refresh/route.ts
 *
 * Point the browser at this deployment with
 * HADES_API_BASE=https://your-app.example/api/hades
 */
import { handleRefresh } from "@/agents/hades/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleRefresh(req);
}
