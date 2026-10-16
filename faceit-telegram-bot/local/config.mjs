import { mkdir, lstat, readFile, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { readProtected } from '../scripts/configure.mjs';

export async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('LOCAL_DIRECTORY_UNSAFE');
}

export async function loadCredentials({ root, telegramTokenFile, faceitKeyFile, chatIds = [] }) {
  if (!Array.isArray(chatIds) || !chatIds.every((id) => Number.isSafeInteger(id) && id < 0)) {
    throw new Error('LOCAL_CHAT_IDS');
  }
  let token, faceitKey;
  try { token = (await readProtected(resolve(telegramTokenFile ?? join(root, '.secrets/telegram-bot.token')))).trim(); }
  catch { throw new Error('LOCAL_TOKEN_FILE'); }
  try { faceitKey = (await readProtected(resolve(faceitKeyFile ?? join(root, '.secrets/faceit.key')))).trim(); }
  catch { throw new Error('LOCAL_FACEIT_FILE'); }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('LOCAL_TOKEN_FORMAT');
  if (faceitKey.length < 16 || /\s/.test(faceitKey)) throw new Error('LOCAL_FACEIT_FORMAT');
  return { token, faceitKey, chatIds: [...new Set(chatIds)] };
}

export async function loadEncryptionKey(root) {
  const folder = join(root, '.secrets');
  await secureDirectory(folder);
  const file = join(folder, 'local-encryption.json');
  try {
    const key = JSON.parse(await readProtected(file));
    if (key.version !== 1 || !/^[a-f0-9]{64}$/.test(key.keyHex) || !/^[a-f0-9]{16}$/.test(key.keyId)) throw new Error('INVALID');
    return key;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('LOCAL_KEY_INVALID');
  }
  // Never replace a lost key when an existing database could contain TS settings.
  try { await lstat(join(root, '.local-data/bot.sqlite')); throw new Error('LOCAL_KEY_MISSING'); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const key = { version: 1, keyHex: randomBytes(32).toString('hex'), keyId: randomBytes(8).toString('hex') };
  const handle = await open(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(key)}\n`, 'utf8'); } finally { await handle.close(); }
  return key;
}

export async function acquireLock(path, { pid = process.pid, isAlive = (id) => {
  try { process.kill(id, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
} } = {}) {
  const nonce = randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      let identity;
      try {
        await handle.writeFile(`${JSON.stringify({ pid, nonce })}\n`);
        identity = await handle.stat();
      } finally { await handle.close(); }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const stat = await lstat(path);
          if (stat.ino !== identity.ino || stat.dev !== identity.dev || stat.isSymbolicLink()) return;
          const current = JSON.parse(await readFile(path, 'utf8'));
          if (current.pid === pid && current.nonce === nonce) await unlink(path);
        } catch (error) { if (error.code !== 'ENOENT') throw new Error('LOCAL_LOCK_RELEASE'); }
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw new Error('LOCAL_LOCK_UNSAFE');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('LOCAL_LOCK_UNSAFE');
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('LOCAL_LOCK_UNSAFE'); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0) throw new Error('LOCAL_LOCK_UNSAFE');
      if (isAlive(previous.pid)) throw new Error('LOCAL_ALREADY_RUNNING');
      // A check followed by unlink cannot atomically reclaim a stale PID file.
      // Fail closed instead of allowing concurrent starters to delete a new lock.
      throw new Error('LOCAL_STALE_LOCK');
    }
  }
  throw new Error('LOCAL_ALREADY_RUNNING');
}
