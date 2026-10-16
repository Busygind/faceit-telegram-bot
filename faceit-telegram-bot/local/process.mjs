import { open, lstat, readFile, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { acquireLock, secureDirectory } from './config.mjs';

const exec = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspectOsProcess(pid, root, nodePath) {
  let details, cwd;
  try {
    const started = await exec('/bin/ps', ['-p', String(pid), '-o', 'lstart=']);
    const command = await exec('/bin/ps', ['-p', String(pid), '-o', 'command=']);
    details = { started: started.stdout.trim(), command: command.stdout.trim() };
    cwd = (await exec('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])).stdout
      .split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1));
  } catch (error) {
    try { process.kill(pid, 0); } catch (check) { if (check.code === 'ESRCH') return null; }
    throw new Error('SWITCH_PROCESS_UNVERIFIED');
  }
  const suffix = [' local/run.mjs', ` ${join(root, 'local/run.mjs')}`].find(value => details.command.endsWith(value));
  let executableMatches = false;
  if (suffix) {
    try { executableMatches = await realpath(details.command.slice(0, -suffix.length)) === await realpath(nodePath); } catch {}
  }
  if (!details.started || !executableMatches || cwd.length !== 1 || await realpath(cwd[0]) !== await realpath(root)) {
    throw new Error('SWITCH_PROCESS_UNVERIFIED');
  }
  return { pid, ...details, cwd: root };
}

/** No pkill, process-name matching, forced kills, or automatic stale-lock removal. */
export function createLocalProcesses({ root, nodePath = process.execPath, inspectProcess = inspectOsProcess,
  kill = (pid, signal) => process.kill(pid, signal), sleep = pause } = {}) {
  root = resolve(root);
  const folder = join(root, '.local-data');
  const lockFile = join(folder, 'polling.lock');

  async function inspect() {
    let stat, lock;
    try { stat = await lstat(lockFile); } catch (error) {
      if (error.code === 'ENOENT') return { state: 'stopped' };
      throw new Error('SWITCH_LOCK_UNSAFE');
    }
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('SWITCH_LOCK_UNSAFE');
    try { lock = JSON.parse(await readFile(lockFile, 'utf8')); } catch { throw new Error('SWITCH_LOCK_UNSAFE'); }
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || !/^[a-f0-9]{32}$/.test(lock.nonce)) throw new Error('SWITCH_LOCK_UNSAFE');
    const os = await inspectProcess(lock.pid, root, nodePath);
    if (!os) throw new Error('SWITCH_STALE_LOCK');
    return { state: 'running', identity: { ...os, nonce: lock.nonce, ino: stat.ino, dev: stat.dev } };
  }

  async function stop(identity) {
    const current = await inspect();
    if (current.state !== 'running' || JSON.stringify(current.identity) !== JSON.stringify(identity)) {
      throw new Error('SWITCH_PROCESS_CHANGED');
    }
    try { kill(identity.pid, 'SIGTERM'); } catch { throw new Error('SWITCH_STOP_FAILED'); }
    for (let elapsed = 0; elapsed < 150_000; elapsed += 100) {
      await sleep(100);
      let alive = true;
      try { kill(identity.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw new Error('SWITCH_STOP_FAILED'); }
      if (!alive) {
        // Graceful runner releases its own identity-checked lock. Do not remove
        // a remaining/replaced lock even if a former owner is now dead.
        const after = await inspect();
        if (after.state !== 'stopped') throw new Error('SWITCH_PROCESS_CHANGED');
        return;
      }
      const os = await inspectProcess(identity.pid, root, nodePath);
      if (!os || os.started !== identity.started || os.command !== identity.command || os.cwd !== identity.cwd) {
        throw new Error('SWITCH_PROCESS_CHANGED');
      }
    }
    throw new Error('SWITCH_STOP_TIMEOUT');
  }

  async function checkpoint() {
    const path = join(folder, 'bot.sqlite');
    let database;
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error();
      database = new DatabaseSync(path, { readOnly: true });
      const row = database.prepare('SELECT next_offset FROM polling_state WHERE singleton=1').get();
      if (!Number.isSafeInteger(row?.next_offset) || row.next_offset < 0) throw new Error();
      return row.next_offset;
    } catch { throw new Error('SWITCH_OFFSET_UNAVAILABLE'); }
    finally { database?.close(); }
  }

  async function guard() { await secureDirectory(folder); return acquireLock(lockFile); }

  async function start() {
    if ((await inspect()).state !== 'stopped') throw new Error('LOCAL_ALREADY_RUNNING');
    await secureDirectory(folder);
    const log = await open(join(folder, 'local-runner.log'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    if (!((await log.stat()).isFile()) || ((await log.stat()).mode & 0o077)) {
      await log.close(); throw new Error('SWITCH_LOG_UNSAFE');
    }
    let child;
    try {
      child = fork(join(root, 'local/run.mjs'), [], { cwd: root, execPath: nodePath, detached: true,
        execArgv: [], stdio: ['ignore', log.fd, log.fd, 'ipc'], env: { ...process.env } });
    } catch { throw new Error('SWITCH_LOCAL_START_FAILED'); }
    finally { await log.close(); }
    try {
      await new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => finish(new Error('SWITCH_LOCAL_START_TIMEOUT')), 45_000);
        const ready = message => { if (message?.event === 'POLLING_READY') finish(); };
        const exited = () => finish(new Error('SWITCH_LOCAL_START_FAILED'));
        const finish = error => {
          clearTimeout(timer); child.off('message', ready); child.off('error', exited); child.off('exit', exited);
          error ? reject(error) : resolveReady();
        };
        child.on('message', ready); child.once('error', exited); child.once('exit', exited);
      });
      const running = await inspect();
      if (running.state !== 'running' || running.identity.pid !== child.pid) throw new Error('SWITCH_LOCAL_NOT_READY');
    } catch (error) {
      // This is our own newly spawned child, not an arbitrary PID from a file.
      // Abort its pending startup so a failed command cannot start polling later.
      try { child.kill('SIGTERM'); } catch {}
      throw error;
    } finally { if (child.connected) child.disconnect(); child.unref(); }
  }
  return { inspect, stop, start, guard, checkpoint };
}
