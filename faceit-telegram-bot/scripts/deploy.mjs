import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { readProtected } from './configure.mjs';
import { validateSettings } from '../tgcloud/lib/settings.js';

const root = resolve(import.meta.dirname, '..');
try {
  const secrets = JSON.parse(await readProtected(resolve(root, '.secrets/runtime.json')));
  validateSettings(secrets);
  const generated = await readProtected(resolve(root, 'tgcloud/lib/private-settings.js'));
  if (!generated.includes(`export default ${JSON.stringify(secrets)};`)) throw new Error('Out-of-sync configuration');
  const check = spawnSync(process.execPath, ['scripts/check.mjs'], { cwd: root, stdio: 'inherit' });
  if (check.status !== 0) throw new Error('Preflight failed');
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--dry-run') console.log('Deploy preflight passed. No upload performed.');
  else {
    if (args.length) throw new Error('Unknown deploy arguments');
    const manifest = JSON.parse(await readFile(resolve(root, 'node_modules/@tgcloud/cli/package.json'), 'utf8'));
    const binary = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.tgcloud;
    const result = spawnSync(process.execPath, [resolve(root, 'node_modules/@tgcloud/cli', binary), 'push'], { cwd: root, stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Cloud push failed');
    console.log('Code pushed. Review and apply schema with npx tgcloud migrate, then npx tgcloud webhook sync.');
  }
} catch {
  console.error('Deploy stopped safely. Configure secrets, install locked dependencies and log in with the Telegram Serverless CLI. No secret or source diff was printed.');
  process.exitCode = 1;
}
