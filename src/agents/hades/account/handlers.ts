import { z } from "zod";
import { AuthError, HadesAccountService } from "./service";

/**
 * Framework-agnostic handlers behind the route files in routes/hades. Keeping
 * the logic here means the routes stay four lines each and the behaviour is
 * testable without spinning up Next.
 */

let service: HadesAccountService | null = null;

/** Override the service — used by tests and by apps wiring a real store. */
export function setHadesAccountService(next: HadesAccountService | null): void {
  service = next;
}

export function getHadesAccountService(): HadesAccountService {
  service ??= new HadesAccountService();
  return service;
}

const signUpSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
  displayName: z.string().max(120).optional(),
  deviceId: z.string().max(120).optional(),
});

const signInSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(512),
  otp: z.string().max(12).optional(),
  deviceId: z.string().max(120).optional(),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
  deviceId: z.string().max(120).optional(),
});

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The sealed payload. 12 bytes of IV is 16 characters of base64; the
 * ciphertext carries a 16-byte tag so it is never shorter than 24. The upper
 * bound is generous for a saved page and small enough that one record cannot
 * be a memory problem.
 */
const envelopeSchema = z
  .object({
    v: z.literal(1),
    iv: z.string().length(16).regex(BASE64),
    ct: z.string().min(24).max(8_000_000).regex(BASE64),
  })
  .strict();

/**
 * `.strict()` is the point: a record carrying `data` or `deleted` in the
 * clear is a client that has not sealed its payload, and the answer is 400
 * rather than storing what it should not have sent.
 */
const syncRecordSchema = z
  .object({
    type: z.string().min(1).max(64),
    id: z.string().min(1).max(200),
    revision: z.number().int().min(0),
    updatedAt: z.number().int().min(0),
    deviceId: z.string().min(1).max(120),
    enc: envelopeSchema,
  })
  .strict();

const syncSchema = z.object({
  deviceId: z.string().min(1).max(120),
  since: z.number().int().min(0).default(0),
  records: z
    .array(syncRecordSchema)
    // A push this large is a client bug; rejecting it beats holding it in memory.
    .max(2_000)
    .default([]),
});

export async function handleSignUp(request: Request): Promise<Response> {
  return guard(async () => {
    const body = signUpSchema.parse(await request.json());
    return json(await getHadesAccountService().signUp(body));
  });
}

export async function handleSignIn(request: Request): Promise<Response> {
  return guard(async () => {
    const body = signInSchema.parse(await request.json());
    return json(await getHadesAccountService().signIn(body));
  });
}

export async function handleRefresh(request: Request): Promise<Response> {
  return guard(async () => {
    const body = refreshSchema.parse(await request.json());
    return json(await getHadesAccountService().refresh(body.refreshToken, body.deviceId));
  });
}

/**
 * Sign-out is client-driven: the browser discards its tokens. The endpoint
 * exists so a deployment that keeps a revocation list has somewhere to hook
 * one in, and answers 204 either way rather than failing a sign-out.
 */
export async function handleSignOut(): Promise<Response> {
  return new Response(null, { status: 204 });
}

export async function handleSync(request: Request): Promise<Response> {
  return guard(async () => {
    const account = await getHadesAccountService().authenticate(
      request.headers.get("authorization"),
    );
    const body = syncSchema.parse(await request.json());
    const result = await getHadesAccountService().sync(account.id, body);
    return json({
      cursor: result.cursor,
      // The browser expects records without the server's own columns.
      records: result.records.map(({ userId: _userId, cursor: _cursor, ...record }) => record),
    });
  });
}

async function guard(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AuthError) {
      return json({ code: error.code, message: error.message }, error.status);
    }
    if (error instanceof z.ZodError) {
      // Not logged: a rejected body may be the very plaintext the schema
      // exists to keep off this server.
      return json({ code: "unknown", message: "The request body is malformed." }, 400);
    }
    // Never echo an internal error to an unauthenticated caller.
    console.error("[hades/account] unhandled error", error);
    return json({ code: "unknown", message: "Something went wrong." }, 500);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
