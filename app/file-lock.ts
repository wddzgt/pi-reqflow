import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const localLocks = new Set<string>();
export const ownsFileLock = (file: string) => localLocks.has(file);

// A separate, table-free file holds the kernel lock. Closing the connection
// or terminating its process releases it without deleting or replacing files.
export function acquireFileLock(file: string, message: string) {
  let connection: DatabaseSync | undefined;
  try {
    connection = new DatabaseSync(file, { timeout: 0 });
    connection.exec('BEGIN EXCLUSIVE');
  } catch (error: any) {
    connection?.close();
    if (error.errcode === 5) throw Object.assign(new Error(message), { code: 'RESOURCE_BUSY', status: 409 });
    throw error;
  }
  localLocks.add(file);
  const owner = connection;
  return () => { owner.close(); localLocks.delete(file); };
}

export function lockedByAnotherProcess(file: string) {
  if (localLocks.has(file) || !statSync(file, { throwIfNoEntry: false })) return false;
  let reader: DatabaseSync | undefined;
  try {
    reader = new DatabaseSync(file, { readOnly: true, timeout: 0 });
    reader.prepare('SELECT count(*) FROM sqlite_schema').get();
    return false;
  } catch (error: any) {
    if (error.errcode === 5) return true;
    throw error;
  } finally { reader?.close(); }
}
