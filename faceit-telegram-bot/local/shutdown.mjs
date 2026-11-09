import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const fields = ['pid', 'nonce', 'ino', 'dev'];
const matches = (left, right) => fields.every(key => left?.[key] === right?.[key]);
const valid = value => Number.isSafeInteger(value?.pid) && value.pid > 0 && /^[a-f0-9]{32}$/.test(value.nonce)
  && Number.isSafeInteger(value.ino) && Number.isSafeInteger(value.dev);
const stopPath = (root, identity) => join(root, '.local-data', `polling-stop-${identity.nonce}.json`);

async function privateJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024
      || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
    return { value: JSON.parse(await file.readFile('utf8')), stat };
  } finally { await file.close(); }
}

export async function readPollingIdentity(root) {
  const { value, stat } = await privateJson(join(root, '.local-data/polling.lock'));
  const identity = { pid: value.pid, nonce: value.nonce, ino: stat.ino, dev: stat.dev };
  if (!valid(identity)) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
  return identity;
}

async function removeOwnRequest(path, identity, expectedStat) {
  try {
    const { value, stat } = await privateJson(path);
    if (value.version === 1 && matches(value.identity, identity)
      && (!expectedStat || stat.ino === expectedStat.ino && stat.dev === expectedStat.dev)) {
      const current = await lstat(path);
      if (!current.isSymbolicLink() && current.ino === stat.ino && current.dev === stat.dev) await unlink(path);
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('LOCAL_STOP_REQUEST_UNSAFE'); }
}

/** Private file capability bound to the current lock generation; no socket or OS stop signal. */
export async function requestLocalStop(root, identity) {
  if (!valid(identity) || !matches(await readPollingIdentity(root), identity)) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
  const folder = await lstat(join(root, '.local-data'));
  if (!folder.isDirectory() || folder.isSymbolicLink() || (folder.mode & 0o077)) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
  const path = stopPath(root, identity);
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let file;
  try {
    file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await file.writeFile(`${JSON.stringify({ version: 1, identity: Object.fromEntries(fields.map(key => [key, identity[key]])) })}\n`);
    await file.close(); file = null;
    // Hard-link publication is atomic and cannot replace another request or symlink.
    try { await link(temporary, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const { value, stat } = await privateJson(path);
    if (value.version !== 1 || !matches(value.identity, identity)) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
    return () => removeOwnRequest(path, identity, stat);
  } finally {
    if (file) await file.close();
    try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

/** Only a request for this exact lock generation may initiate a graceful drain. */
export async function watchLocalStop(root, { onStop, onInvalid = () => {}, intervalMs = 100 } = {}) {
  const identity = await readPollingIdentity(root);
  if (identity.pid !== process.pid) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
  const path = stopPath(root, identity);
  let inFlight, accepted, closed = false;
  const check = async () => {
    try {
      const { value, stat } = await privateJson(path);
      if (value.version !== 1 || !matches(value.identity, identity)) throw new Error('LOCAL_STOP_REQUEST_UNSAFE');
      accepted = stat;
      onStop();
    } catch (error) { if (error.code !== 'ENOENT') onInvalid(); }
  };
  const timer = setInterval(() => {
    if (!closed && !inFlight && !accepted) inFlight = check().finally(() => { inFlight = null; });
  }, intervalMs);
  return async () => {
    closed = true; clearInterval(timer);
    await inFlight;
    if (accepted) await removeOwnRequest(path, identity, accepted);
  };
}
