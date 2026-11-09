import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../local/config.mjs';
import { readPollingIdentity, requestLocalStop, watchLocalStop } from '../local/shutdown.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'faceit-shutdown-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const folder = join(root, '.local-data');
  await mkdir(folder, { mode: 0o700 });
  const release = await acquireLock(join(folder, 'polling.lock'));
  t.after(release);
  const identity = await readPollingIdentity(root);
  return { root, folder, identity, path: join(folder, `polling-stop-${identity.nonce}.json`) };
}
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('private stop request was not observed');
}

test('private stop protocol is atomic, identity-bound, idempotent and cleans only its accepted request', async t => {
  const f = await fixture(t);
  let stops = 0;
  const close = await watchLocalStop(f.root, { onStop: () => { stops++; }, intervalMs: 2 });
  t.after(close);
  const clear = await requestLocalStop(f.root, f.identity);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  await requestLocalStop(f.root, f.identity);
  await until(() => stops > 0);
  await close();
  await clear();
  assert.equal(stops, 1);
  assert.deepEqual(await readdir(f.folder), ['polling.lock']);
});

test('a request for another lock generation cannot stop a new runner', async t => {
  const f = await fixture(t);
  const oldIdentity = { ...f.identity, nonce: 'cd'.repeat(16) };
  await assert.rejects(requestLocalStop(f.root, oldIdentity), /LOCAL_STOP_REQUEST_UNSAFE/);
  await writeFile(join(f.folder, `polling-stop-${oldIdentity.nonce}.json`), JSON.stringify({ version: 1, identity: oldIdentity }), { mode: 0o600 });
  let stops = 0, invalid = 0;
  const close = await watchLocalStop(f.root, { onStop: () => stops++, onInvalid: () => invalid++, intervalMs: 2 });
  t.after(close);
  await writeFile(f.path, JSON.stringify({ version: 1, identity: { ...f.identity, ino: f.identity.ino + 1 } }), { mode: 0o600 });
  await until(() => invalid > 0);
  assert.equal(stops, 0);
  await close();
  assert.ok((await readFile(f.path, 'utf8')).includes('identity'));
});

test('stop protocol refuses public files, malformed contents, replaced lock and symlinks', async t => {
  const f = await fixture(t);
  const close = await watchLocalStop(f.root, { onStop: () => assert.fail('unverified stop') });
  t.after(close);
  await writeFile(f.path, '{}', { mode: 0o600 });
  await assert.rejects(requestLocalStop(f.root, f.identity), /LOCAL_STOP_REQUEST_UNSAFE/);
  await chmod(f.path, 0o644);
  await assert.rejects(requestLocalStop(f.root, f.identity), /LOCAL_STOP_REQUEST_UNSAFE/);
  await unlink(f.path);
  const target = join(f.folder, 'untouched');
  await writeFile(target, 'untouched', { mode: 0o600 });
  await symlink(target, f.path);
  await assert.rejects(requestLocalStop(f.root, f.identity));
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  assert.ok(!(await readdir(f.folder)).some(name => name.endsWith('.tmp')));
  await unlink(join(f.folder, 'polling.lock'));
  await writeFile(join(f.folder, 'polling.lock'), JSON.stringify({ pid: process.pid, nonce: 'ef'.repeat(16) }), { mode: 0o600 });
  await assert.rejects(requestLocalStop(f.root, f.identity), /LOCAL_STOP_REQUEST_UNSAFE/);
});

test('request cleanup never removes a replacement belonging to another lock generation', async t => {
  const f = await fixture(t);
  const clear = await requestLocalStop(f.root, f.identity);
  await unlink(f.path);
  const replacement = JSON.stringify({ version: 1, identity: { ...f.identity, nonce: 'cd'.repeat(16) } });
  await writeFile(f.path, replacement, { mode: 0o600 });
  await clear();
  assert.equal(await readFile(f.path, 'utf8'), replacement);
});
