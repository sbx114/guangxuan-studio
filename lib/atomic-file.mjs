import { rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS = [20, 40, 80, 120, 160, 200, 240, 320];

// Windows readers and scanners may briefly deny delete sharing. Retrying the
// rename keeps replacement atomic; the destination is never unlinked first.
export async function renameWithRetry(source, destination, { renameOperation = rename, wait = sleep, signal } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await renameOperation(source, destination); }
    catch (error) {
      signal?.throwIfAborted();
      if (!TRANSIENT_RENAME.has(error?.code) || attempt >= DELAYS.length) throw error;
      await wait(DELAYS[attempt], undefined, signal ? { signal } : undefined);
    }
  }
}
