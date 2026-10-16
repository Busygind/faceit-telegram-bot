import { mkdir, readFile, writeFile, rename, chmod, lstat, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateSettings } from '../tgcloud/lib/settings.js';

async function protectedDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe secrets directory.');
  await chmod(path, 0o700);
}
async function atomicWrite(path, data) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
    await chmod(path, 0o600);
  } finally { await rm(temp, { force: true }); }
}
export async function readProtected(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) {
    throw new Error('Secret file must be a regular non-symlink file with mode 0600.');
  }
  return readFile(path, 'utf8');
}
export async function configure({ root, faceitKey, allowedChatIds, bootstrap = false }) {
  validateSettings({ allowedChatIds, faceitKey, encryptionKeyHex: '00'.repeat(32), encryptionKeyId: 'preflight', maxRequests: 8 });
  if (!allowedChatIds.length && !bootstrap) throw new Error('Specify at least one group chat ID.');
  const folder = resolve(root, '.secrets');
  const secretsPath = resolve(folder, 'runtime.json');
  const modulePath = resolve(root, 'tgcloud/lib/private-settings.js');
  await protectedDirectory(folder);
  let previous;
  try { previous = JSON.parse(await readProtected(secretsPath)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read protected configuration. Restore it; do not reset the encryption key.');
    // If a deployed/generated module exists but its original key file was lost,
    // refuse to silently create a replacement key that cannot decrypt the DB.
    try {
      const current = await readFile(modulePath, 'utf8');
      if (!current.includes('export default DEFAULT_SETTINGS;')) throw new Error('Existing private module requires its original .secrets/runtime.json.');
    } catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
  }
  const settings = {
    allowedChatIds: [...new Set(allowedChatIds)], faceitKey,
    encryptionKeyHex: previous?.encryptionKeyHex ?? randomBytes(32).toString('hex'),
    encryptionKeyId: previous?.encryptionKeyId ?? randomBytes(8).toString('hex'),
    maxRequests: previous?.maxRequests ?? 8,
  };
  validateSettings(settings);
  await atomicWrite(secretsPath, `${JSON.stringify(settings, null, 2)}\n`);
  await atomicWrite(modulePath, `// Generated private server-side configuration. Do not commit, diff or log.\nexport default ${JSON.stringify(settings)};\n`);
}

async function main() {
  const args = process.argv.slice(2);
  const chatIds = [];
  let keyFile;
  let bootstrap = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chat-id') chatIds.push(Number(args[++i]));
    else if (args[i] === '--bootstrap') bootstrap = true;
    else if (args[i] === '--faceit-key-file') keyFile = args[++i];
    else throw new Error('Use --faceit-key-file PATH --chat-id -100... [--chat-id -100...]. Never pass a key as an argument.');
  }
  const faceitKey = keyFile ? (await readProtected(resolve(keyFile))).trim() : process.env.FACEIT_API_KEY?.trim();
  if (!faceitKey) throw new Error('Set FACEIT_API_KEY privately or supply a mode-0600 key file.');
  await configure({ root: resolve(import.meta.dirname, '..'), faceitKey, allowedChatIds: chatIds, bootstrap });
  console.log('Configuration written with protected permissions. Existing encryption key preserved. No secret values printed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('Configuration failed. Check arguments, group IDs, secret file permissions and existing .secrets key backup. No settings were printed.'); process.exitCode = 1; });
}
