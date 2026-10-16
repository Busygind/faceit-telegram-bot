// All SQL values are bound. No raw Telegram message/update or secret is persisted.
export const SQL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chat_settings (
    chat_id INTEGER PRIMARY KEY, origin_chat_id INTEGER NOT NULL,
    ciphertext TEXT, version INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS deliveries (
    request_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, topic_id INTEGER,
    kind TEXT NOT NULL, status TEXT NOT NULL, message_id INTEGER, poll_id TEXT,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS report_jobs (
    job_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, topic_id INTEGER,
    state TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
    lease_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_updated ON report_jobs(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_updated ON deliveries(updated_at)`,
];

export class Store {
  constructor(db, now = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }

  async getSettings(chatId) {
    return (await this.db.get('SELECT * FROM chat_settings WHERE chat_id = :id', { ':id': chatId })) ?? null;
  }

  async allowed(chatId, allowedChatIds) {
    const row = await this.getSettings(chatId);
    if (row && allowedChatIds.includes(row.origin_chat_id)) return true;
    if (!allowedChatIds.includes(chatId)) return false;
    // An old basic-group ID is permanently retired after migration.
    return !(await this.db.get('SELECT chat_id FROM chat_settings WHERE origin_chat_id = :id AND chat_id != :id', { ':id': chatId }));
  }

  async saveSettings(chatId, credentials, sealer) {
    const old = await this.getSettings(chatId);
    const version = (old?.version ?? 0) + 1;
    const ciphertext = sealer.seal(chatId, credentials.host, credentials.password, version);
    const params = { ':id': chatId, ':cipher': ciphertext, ':version': version, ':now': this.now() };
    const result = old
      ? await this.db.run(`UPDATE chat_settings SET ciphertext=:cipher, version=:version, updated_at=:now
          WHERE chat_id=:id AND version=:previous`, { ...params, ':previous': old.version })
      : await this.db.run(`INSERT INTO chat_settings(chat_id,origin_chat_id,ciphertext,version,updated_at)
          VALUES(:id,:id,:cipher,:version,:now) ON CONFLICT(chat_id) DO NOTHING`, params);
    if (result.rowsAffected !== 1) throw new Error('SETTINGS_CONFLICT');
  }

  async migrateChat(oldId, newId, allowedChatIds, sealer) {
    if (oldId === newId || !Number.isSafeInteger(newId) || newId >= 0) return false;
    if (!(await this.allowed(oldId, allowedChatIds))) return false;
    await this.db.run(`INSERT INTO chat_settings(chat_id,origin_chat_id,version,updated_at)
      VALUES(:old,:old,0,:now) ON CONFLICT(chat_id) DO NOTHING`, { ':old': oldId, ':now': this.now() });
    const old = await this.getSettings(oldId);
    if (!old) return false;
    // Reseal for the new chat's AAD. One UPDATE moves the row atomically;
    // never overwrite an independently configured destination.
    const version = old.version + 1;
    const clear = old.ciphertext ? sealer.open(oldId, old.ciphertext) : null;
    const ciphertext = clear ? sealer.seal(newId, clear.host, clear.password, version) : null;
    try {
      const result = await this.db.run(`UPDATE chat_settings SET chat_id=:new,ciphertext=:cipher,
        version=:version,updated_at=:now WHERE chat_id=:old AND version=:previous
        AND NOT EXISTS(SELECT 1 FROM chat_settings WHERE chat_id=:new)`, {
        ':new': newId, ':old': oldId, ':cipher': ciphertext, ':version': version,
        ':previous': old.version, ':now': this.now(),
      });
      return result.rowsAffected === 1;
    } catch { return false; }
  }

  async claimDelivery(requestId, chatId, topicId, kind) {
    const result = await this.db.run(`INSERT INTO deliveries(request_id,chat_id,topic_id,kind,status,updated_at)
      VALUES(:id,:chat,:topic,:kind,'claimed',:now) ON CONFLICT(request_id) DO NOTHING`, {
      ':id': requestId, ':chat': chatId, ':topic': topicId ?? null, ':kind': kind, ':now': this.now(),
    });
    return result.rowsAffected === 1;
  }

  async finishDelivery(requestId, status, message = {}) {
    await this.db.run(`UPDATE deliveries SET status=:status,message_id=:message,poll_id=:poll,updated_at=:now
      WHERE request_id=:id`, {
      ':id': requestId, ':status': status, ':message': message.message_id ?? null,
      ':poll': message.poll?.id ?? null, ':now': this.now(),
    });
  }

  async createJob(jobId, chatId, topicId, state) {
    await this.db.run(`INSERT INTO report_jobs(job_id,chat_id,topic_id,state,status,version,lease_until,updated_at)
      VALUES(:id,:chat,:topic,:state,'pending',0,0,:now)`, {
      ':id': jobId, ':chat': chatId, ':topic': topicId ?? null,
      ':state': JSON.stringify(state), ':now': this.now(),
    });
  }

  async getJob(jobId) {
    const row = await this.db.get('SELECT * FROM report_jobs WHERE job_id=:id', { ':id': jobId });
    if (!row) return null;
    return { ...row, state: JSON.parse(row.state) };
  }

  async leaseJob(jobId, version) {
    const result = await this.db.run(`UPDATE report_jobs SET status='running',lease_until=:lease,updated_at=:now
      WHERE job_id=:id AND version=:version AND (status='pending' OR (status='running' AND lease_until<:now))
      AND NOT EXISTS (SELECT 1 FROM report_jobs AS other WHERE other.job_id<>:id
        AND other.chat_id=report_jobs.chat_id AND other.status='running' AND other.lease_until>=:now)`, {
      ':id': jobId, ':version': version, ':lease': this.now() + 120, ':now': this.now(),
    });
    return result.rowsAffected === 1;
  }

  async saveJob(jobId, version, state, status) {
    const result = await this.db.run(`UPDATE report_jobs SET state=:state,status=:status,version=version+1,
      lease_until=0,updated_at=:now WHERE job_id=:id AND version=:version`, {
      ':id': jobId, ':version': version, ':state': JSON.stringify(state), ':status': status, ':now': this.now(),
    });
    if (result.rowsAffected !== 1) throw new Error('JOB_CONFLICT');
  }

  async cleanup() {
    // Seven days for transient public reports; dedup tombstones retained 30 days.
    await this.db.run('DELETE FROM report_jobs WHERE updated_at<:cutoff', { ':cutoff': this.now() - 7 * 86400 });
    await this.db.run('DELETE FROM deliveries WHERE updated_at<:cutoff', { ':cutoff': this.now() - 30 * 86400 });
  }
}
