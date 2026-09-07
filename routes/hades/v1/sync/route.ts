/**
 * DROP THIS FILE INTO: your-app/src/app/api/hades/v1/sync/route.ts
 *
 * One round trip: the browser pushes what it has and receives everything newer
 * than the cursor it last saw. Last-write-wins per record, resolved with the
 * same rule both ends run, so two devices converge without a server merge.
 *
 * What crosses this endpoint is end-to-end encrypted. Each record is
 *
 *   { type, id, revision, updatedAt, deviceId, enc: { v: 1, iv, ct } }
 *
 * where `enc` is the payload under AES-256-GCM with a key the browser derives
 * from the user's password and never sends. This server can see which records
 * exist, how often they change and from which device, and can pick the newest
 * copy; it cannot read a workspace name, a collection, or the text of a saved
 * page, and it cannot alter a payload or move it to another record without
 * the browser refusing it. A record that arrives with its payload in the
 * clear is rejected with 400 and not logged.
 *
 * Because the payload is opaque there is nothing here to search or index, and
 * a deployment must not try — a store adapter treats `enc` as a blob.
 *
 * Rows written by a deployment from before the envelope, with a plaintext
 * `data` field, are returned as they are. The browser recognises them,
 * imports them once, and re-uploads them sealed at a higher revision, which
 * overwrites the plaintext copy.
 */
import { handleSync } from "@/agents/hades/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleSync(req);
}
