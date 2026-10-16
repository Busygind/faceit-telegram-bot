import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configure, readProtected } from '../scripts/configure.mjs';

test('configuration needs no chat IDs, creates protected files and preserves encryption keys on update', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  const key = 'not-a-real-faceit-key-for-offline-tests';
  await configure({ root, faceitKey: key });
  const path = join(root, '.secrets/runtime.json');
  const first = JSON.parse(await readProtected(path));
  assert.equal(first.encryptionKeyHex.length, 64);
  assert.equal(Object.hasOwn(first, 'allowedChatIds'), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, '.secrets'))).mode & 0o777, 0o700);
  // Reconfiguration strips a persisted legacy allowlist without rotating secrets.
  await writeFile(path, `${JSON.stringify({ ...first, allowedChatIds: [-10] })}\n`, { mode: 0o600 });
  await configure({ root, faceitKey: 'new-key-for-offline-configuration-tests' });
  const next = JSON.parse(await readProtected(path));
  assert.equal(next.encryptionKeyHex, first.encryptionKeyHex);
  assert.equal(next.encryptionKeyId, first.encryptionKeyId);
  assert.equal(Object.hasOwn(next, 'allowedChatIds'), false);
  assert.equal(next.faceitKey, 'new-key-for-offline-configuration-tests');
  assert.ok((await readFile(join(root, 'tgcloud/lib/private-settings.js'), 'utf8')).includes('export default'));
});

test('missing key backup cannot silently reset existing generated encryption key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  await writeFile(join(root, 'tgcloud/lib/private-settings.js'), 'export default {existing:true};\n', { mode: 0o600 });
  await assert.rejects(configure({ root, faceitKey: 'not-a-real-faceit-key-for-offline-tests' }), /original/);
  assert.equal(await readFile(join(root, 'tgcloud/lib/private-settings.js'), 'utf8'), 'export default {existing:true};\n');
});

test('unsafe secret permissions and symlinks rejected; invalid config does not write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'key');
  await writeFile(path, 'fake', { mode: 0o644 }); await chmod(path, 0o644);
  await assert.rejects(readProtected(path), /0600/);
  await chmod(path, 0o600); assert.equal(await readProtected(path), 'fake');
  await symlink(path, join(root, 'link'));
  await assert.rejects(readProtected(join(root, 'link')), /0600/);
  await assert.rejects(configure({ root, faceitKey: '' }), /CONFIG_FACEIT_KEY/);
  await assert.rejects(stat(join(root, '.secrets')), { code: 'ENOENT' });
});

test('legacy allowlist arguments cannot restrict freshly generated configuration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  await configure({ root, faceitKey: 'offline-configuration-faceit-key', allowedChatIds: [] });
  const settings = JSON.parse(await readProtected(join(root, '.secrets/runtime.json')));
  assert.equal(Object.hasOwn(settings, 'allowedChatIds'), false);
  assert.ok(!(await readProtected(join(root, 'tgcloud/lib/private-settings.js'))).includes('allowedChatIds'));
});

test('Serverless deploy preflight accepts configuration without whitelist or bootstrap and prints no private module', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-deploy-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true }); await mkdir(join(root, 'scripts'));
  for (const file of ['scripts/deploy.mjs', 'scripts/configure.mjs', 'tgcloud/lib/settings.js']) {
    await copyFile(new URL(`../${file}`, import.meta.url), join(root, file));
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(root, 'scripts/check.mjs'), 'console.log("fixture preflight check passed");\n');
  const key = 'offline-private-deployment-test-key';
  await configure({ root, faceitKey: key });
  for (const legacy of [false, true]) {
    if (legacy) {
      const secretPath = join(root, '.secrets/runtime.json'); const settings = JSON.parse(await readProtected(secretPath));
      settings.allowedChatIds = []; // Existing installations remain deployable without key rotation.
      await writeFile(secretPath, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
      await writeFile(join(root, 'tgcloud/lib/private-settings.js'), `export default ${JSON.stringify(settings)};\n`, { mode: 0o600 });
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts/deploy.mjs'), '--dry-run'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Deploy preflight passed/);
    assert.doesNotMatch(result.stdout, /Bootstrap|allowedChatIds|export default/);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
  }
});
