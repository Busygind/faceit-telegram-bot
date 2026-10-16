import { DatabaseSync } from 'node:sqlite';
import { Store, SQL_SCHEMA } from '../tgcloud/lib/store.js';

export function makeDb() {
  const sqlite = new DatabaseSync(':memory:');
  const call = (sql, params, method) => {
    const statement = sqlite.prepare(sql);
    return params ? statement[method](params) : statement[method]();
  };
  return {
    sqlite,
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
    close() { sqlite.close(); },
  };
}
export async function makeStore(now = () => 1800000000) {
  const db = makeDb();
  for (const sql of SQL_SCHEMA) await db.run(sql);
  return { store: new Store(db, now), db };
}
