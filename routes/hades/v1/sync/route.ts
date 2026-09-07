/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/v1/sync/route.ts
 *
 * One round trip: the browser pushes what it has and receives everything newer
 * than the cursor it last saw. Last-write-wins per record, resolved with the
 * same rule both ends run, so two devices converge without a server merge.
 */
import { handleSync } from "@/agents/hades/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleSync(req);
}
