import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configure, readProtected } from '../scripts/configure.mjs';

test('configuration creates protected files, preserves key on update and never needs API token', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  const key = 'not-a-real-faceit-key-for-offline-tests';
  await configure({ root, faceitKey: key, allowedChatIds: [-10, -20, -10] });
  const path = join(root, '.secrets/runtime.json');
  const first = JSON.parse(await readProtected(path));
  assert.equal(first.encryptionKeyHex.length, 64);
  assert.deepEqual(first.allowedChatIds, [-10, -20]);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, '.secrets'))).mode & 0o777, 0o700);
  await configure({ root, faceitKey: 'new-key-for-offline-configuration-tests', allowedChatIds: [-30] });
  const next = JSON.parse(await readProtected(path));
  assert.equal(next.encryptionKeyHex, first.encryptionKeyHex);
  assert.equal(next.encryptionKeyId, first.encryptionKeyId);
  assert.ok((await readFile(join(root, 'tgcloud/lib/private-settings.js'), 'utf8')).includes('export default'));
});

test('missing key backup cannot silently reset existing generated encryption key', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  await writeFile(join(root, 'tgcloud/lib/private-settings.js'), 'export default {existing:true};\n', { mode: 0o600 });
  await assert.rejects(configure({ root, faceitKey: 'not-a-real-faceit-key-for-offline-tests', allowedChatIds: [-10] }), /original/);
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
  await assert.rejects(configure({ root, faceitKey: 'not-a-real-faceit-key-for-offline-tests', allowedChatIds: [] }), /at least/);
});

test('explicit bootstrap allows only chat-ID discovery, no groups enabled by default', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'faceit-config-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tgcloud/lib'), { recursive: true });
  await configure({ root, faceitKey: 'offline-bootstrap-faceit-key', allowedChatIds: [], bootstrap: true });
  const settings = JSON.parse(await readProtected(join(root, '.secrets/runtime.json')));
  assert.deepEqual(settings.allowedChatIds, []);
});
