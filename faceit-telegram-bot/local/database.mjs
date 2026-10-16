import { constants } from 'node:fs';
import { chmod, lstat, open } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { SQL_SCHEMA } from '../tgcloud/lib/store.js';
import { REPORT_CACHE_SCHEMA } from './report-cache.mjs';

const POLLING_SCHEMA = `CREATE TABLE IF NOT EXISTS polling_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  next_offset INTEGER NOT NULL CHECK(next_offset >= 0)
)`;

async function privateFile(path, create = false) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!create) return;
    const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await file.close();
    stat = await lstat(path);
  }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('LOCAL_DATABASE_UNSAFE_PATH');
  await chmod(path, 0o600);
}

/** Persistent native SQLite adapter compatible with the shared Store. */
export async function openDatabase(path) {
  if (typeof path !== 'string' || !path || path === ':memory:') throw new Error('LOCAL_DATABASE_UNSAFE_PATH');
  let sqlite;
  try {
    await privateFile(path, true);
    await privateFile(`${path}-wal`);
    await privateFile(`${path}-shm`);
    await privateFile(`${path}-journal`);
    sqlite = new DatabaseSync(path);
    sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
    let closed = false;
    const call = (sql, params, method) => {
      if (closed) throw new Error('LOCAL_DATABASE_CLOSED');
      const statement = sqlite.prepare(sql);
      if (Array.isArray(params)) return statement[method](...params);
      return params === undefined ? statement[method]() : statement[method](params);
    };
    const db = Object.freeze({
      async run(sql, params) {
        if (/\bRETURNING\b/i.test(sql)) {
          const rows = call(sql, params, 'all');
          return { rowsAffected: rows.length, rows, lastInsertRowid: 0 };
        }
        const result = call(sql, params, 'run');
        return { rowsAffected: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid), rows: [] };
      },
      async get(sql, params) { return call(sql, params, 'get'); },
      async all(sql, params) { return call(sql, params, 'all'); },
    });
    for (const sql of [...SQL_SCHEMA, ...REPORT_CACHE_SCHEMA]) await db.run(sql);
    await db.run(POLLING_SCHEMA);
    await db.run('INSERT INTO polling_state(singleton,next_offset) VALUES(1,0) ON CONFLICT(singleton) DO NOTHING');
    await privateFile(`${path}-wal`);
    await privateFile(`${path}-shm`);
    return Object.freeze({
      db,
      async getOffset() {
        const row = await db.get('SELECT next_offset FROM polling_state WHERE singleton=1');
        if (!Number.isSafeInteger(row?.next_offset) || row.next_offset < 0) throw new Error('LOCAL_DATABASE_INVALID_OFFSET');
        return row.next_offset;
      },
      async setOffset(next) {
        if (!Number.isSafeInteger(next) || next < 0) throw new Error('LOCAL_DATABASE_INVALID_OFFSET');
        await db.run('UPDATE polling_state SET next_offset=MAX(next_offset,:next) WHERE singleton=1', { ':next': next });
      },
      close() {
        if (!closed) {
          sqlite.close();
          closed = true;
        }
      },
    });
  } catch (error) {
    try { sqlite?.close(); } catch { /* Preserve a safe opening error only. */ }
    if (error?.message === 'LOCAL_DATABASE_UNSAFE_PATH') throw error;
    throw new Error('LOCAL_DATABASE_OPEN_FAILED');
  }
}
