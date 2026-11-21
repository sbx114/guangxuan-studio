import { rename } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const TRANSIENT_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);
const DELAYS = [20, 40, 80, 160, 240];

// Windows readers and scanners may briefly deny delete sharing. Retrying the
// rename keeps replacement atomic; the destination is never unlinked first.
export async function renameWithRetry(source, destination, { renameOperation = rename, wait = sleep } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await renameOperation(source, destination); }
    catch (error) {
      if (!TRANSIENT_RENAME.has(error?.code) || attempt >= DELAYS.length) throw error;
      await wait(DELAYS[attempt]);
    }
  }
}
