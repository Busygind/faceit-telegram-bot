import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

/** Non-secret handover deadline persists even if the operator closes the CLI. */
export function createDrainState(root) {
  const path = join(root, '.local-data/cloud-drain.json');
  async function readDrain() {
    let stat;
    try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return 0; throw new Error('SWITCH_DRAIN_UNSAFE'); }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('SWITCH_DRAIN_UNSAFE');
    let data;
    try { data = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('SWITCH_DRAIN_UNSAFE'); }
    if (data.version !== 1 || !Number.isSafeInteger(data.until) || data.until < 0) throw new Error('SWITCH_DRAIN_UNSAFE');
    return data.until;
  }
  async function writeDrain(until) {
    if (!Number.isSafeInteger(until) || until < 0) throw new Error('SWITCH_DRAIN_UNSAFE');
    await readDrain();
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    let file;
    try {
      file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(`${JSON.stringify({ version: 1, until })}\n`);
      await file.close(); file = null;
      await rename(temp, path);
    } finally {
      if (file) await file.close();
      try { await unlink(temp); } catch (error) { if (error.code !== 'ENOENT') throw new Error('SWITCH_DRAIN_UNSAFE'); }
    }
  }
  async function clearDrain() {
    await readDrain();
    try { await unlink(path); } catch (error) { if (error.code !== 'ENOENT') throw new Error('SWITCH_DRAIN_UNSAFE'); }
  }
  return { readDrain, writeDrain, clearDrain };
}
