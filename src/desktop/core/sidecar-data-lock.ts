import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export class SidecarDataInUseError extends Error {
  constructor() { super('Hades is already using this data folder. Close the other Hades application, then relaunch this one. No second workspace was started.'); this.name = 'SidecarDataInUseError'; }
}

export interface SidecarDataLock { directory: string; release(): void }
/** Cooperative lifetime ownership of one local sidecar data directory.
 * SQLite owns the OS lock, so process death releases it without PID guesses.
 * Never delete/replace this file: another process could still hold its inode.
 * Does not arbitrate arbitrary CLI writers or hostile filesystem replacement.
 */
export function acquireSidecarDataLock(dataDir: string): SidecarDataLock {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const directory = realpathSync(dataDir), path = join(directory, 'desktop-owner.sqlite');
  try { closeSync(openSync(path, 'wx', 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Hades data ownership file is not a private regular file. Inspect the data folder before starting.');
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const current = lstatSync(path);
    if (current.dev !== stat.dev || current.ino !== stat.ino) throw new Error('Hades data ownership file changed during startup.');
  } catch (error) {
    try { db?.close(); } catch { /* preserve the original failure */ }
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) throw new SidecarDataInUseError();
    throw error;
  }
  let released = false;
  return { directory, release() {
    if (released) return;
    released = true;
    db!.close();
  } };
}

/** An inert rejected second instance can explain boot failure over the native RPC.
 * No service is constructed and no request is dispatched. EOF ends the responder.
 */
export async function serveSidecarLockFailure(input: AsyncIterable<string | Buffer>, output: (line: string) => void, error: SidecarDataInUseError): Promise<void> {
  const decoder = new StringDecoder('utf8');
  let buffer = '', dropping = false;
  for await (const chunk of input) {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    for (const part of text.split(/(?<=\n)/)) {
      const ended = part.endsWith('\n');
      if (!dropping) {
        buffer += part;
        if (buffer.length > 65536) { buffer = ''; dropping = true; }
      }
      if (!ended) continue;
      if (!dropping) {
        try {
          const request = JSON.parse(buffer);
          if (request?.kind === 'desktop.request' && typeof request.id === 'string' && request.id.length <= 200) {
            output(JSON.stringify({kind:'desktop.response',id:request.id,error:error.message})+'\n');
          }
        } catch { /* malformed input cannot start any service */ }
      }
      buffer = ''; dropping = false;
    }
  }
}
