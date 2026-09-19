/**
 * Adapter-level ownership. HTTP routes already 404 on a foreign thread,
 * but Supabase / Prisma / memory still loaded the row if you knew the id.
 * When `userId` is passed, adapters must hide or refuse foreign rows.
 */

export function ownedOrNull<T>(
  row: T | null | undefined,
  ownerId: string | undefined,
  userId?: string
): T | null {
  if (!row) return null;
  if (userId && ownerId !== userId) return null;
  return row;
}

export function assertOwned(
  ownerId: string | undefined,
  userId: string | undefined,
  action: string
): void {
  if (userId && ownerId !== userId) {
    throw new Error(`Unauthorized: cannot ${action} another user's thread`);
  }
}
