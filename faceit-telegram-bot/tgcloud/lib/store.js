import { normalizePollFence, pollWindow } from './poll-window.js';

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
  `CREATE TABLE IF NOT EXISTS player_links (
    chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, player_id TEXT NOT NULL,
    nickname TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_player_links_chat_user ON player_links(chat_id,user_id)`,
  `CREATE TABLE IF NOT EXISTS poll_state (
    chat_id INTEGER PRIMARY KEY, original_message_id INTEGER, poll_id TEXT, created_at INTEGER,
    latest_message_id INTEGER, pinned_message_id INTEGER, pending_unpin_ids TEXT NOT NULL DEFAULT '[]',
    owner_request_id TEXT, phase TEXT NOT NULL DEFAULT 'idle', lease_until INTEGER NOT NULL DEFAULT 0,
    unknown_until INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS poll_requests (
    request_id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_poll_requests_updated ON poll_requests(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_updated ON report_jobs(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_deliveries_updated ON deliveries(updated_at)`,
];

function validatePlayerLinkOwner(chatId, userId) {
  if (!Number.isSafeInteger(chatId) || chatId >= 0 || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('PLAYER_LINK_INVALID');
  }
}

function validatePlayerLinkProfile(profile) {
  if (!profile || typeof profile.playerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(profile.playerId)
    || typeof profile.nickname !== 'string' || profile.nickname.length < 1 || profile.nickname.length > 64
    || /[\s\p{Cc}\p{Cf}]/u.test(profile.nickname)) throw new Error('PLAYER_LINK_INVALID');
}

export class Store {
  constructor(db, now = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.now = now;
  }

  async getPlayerLink(chatId, userId) {
    validatePlayerLinkOwner(chatId, userId);
    return (await this.db.get('SELECT * FROM player_links WHERE chat_id=:chat AND user_id=:user', {
      ':chat': chatId, ':user': userId,
    })) ?? null;
  }

  async savePlayerLink(chatId, userId, profile) {
    validatePlayerLinkOwner(chatId, userId);
    validatePlayerLinkProfile(profile);
    await this.db.run(`INSERT INTO player_links(chat_id,user_id,player_id,nickname,updated_at)
      VALUES(:chat,:user,:player,:nickname,:now) ON CONFLICT(chat_id,user_id)
      DO UPDATE SET player_id=excluded.player_id,nickname=excluded.nickname,updated_at=excluded.updated_at`, {
      ':chat': chatId, ':user': userId, ':player': profile.playerId, ':nickname': profile.nickname, ':now': this.now(),
    });
  }

  async deletePlayerLink(chatId, userId) {
    validatePlayerLinkOwner(chatId, userId);
    await this.db.run('DELETE FROM player_links WHERE chat_id=:chat AND user_id=:user', {
      ':chat': chatId, ':user': userId,
    });
  }

  async getSettings(chatId) {
    return (await this.db.get('SELECT * FROM chat_settings WHERE chat_id = :id', { ':id': chatId })) ?? null;
  }

  async allowed(chatId) {
    if (!Number.isSafeInteger(chatId) || chatId >= 0) return false;
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

  async migrateChat(oldId, newId, sealer) {
    if (oldId === newId || !(await this.allowed(oldId)) || !(await this.allowed(newId))) return false;
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

  async getPollState(chatId) {
    const row = await this.db.get('SELECT * FROM poll_state WHERE chat_id=:chat', { ':chat': chatId });
    if (!row) return null;
    return { ...row, unknown_until: normalizePollFence(row.unknown_until),
      pending_unpin_ids: JSON.parse(row.pending_unpin_ids) };
  }

  async claimPollRun(chatId, requestId) {
    if (!Number.isSafeInteger(chatId) || chatId >= 0 || typeof requestId !== 'string'
      || !/^[A-Za-z0-9:_-]{1,160}$/.test(requestId)) throw new Error('POLL_INPUT_INVALID');
    const request = await this.db.run(`INSERT INTO poll_requests(request_id,chat_id,status,updated_at)
      VALUES(:request,:chat,'claimed',:now) ON CONFLICT(request_id) DO NOTHING`, {
      ':request': requestId, ':chat': chatId, ':now': this.now(),
    });
    if (request.rowsAffected !== 1) return { status: 'duplicate' };
    // Adopt the last confirmed pre-upgrade poll without touching existing state.
    // Its pin is unknown: never assume it is safe to remove arbitrary chat pins.
    await this.db.run(`INSERT INTO poll_state(chat_id,original_message_id,poll_id,created_at,updated_at)
      SELECT :chat,legacy.message_id,legacy.poll_id,legacy.updated_at,:now FROM (SELECT 1) AS seed
      LEFT JOIN (SELECT message_id,poll_id,updated_at FROM deliveries WHERE chat_id=:chat
        AND status='sent' AND message_id>0 AND poll_id IS NOT NULL
        ORDER BY updated_at DESC,message_id DESC LIMIT 1) AS legacy ON 1=1 WHERE 1=1
      ON CONFLICT(chat_id) DO NOTHING`, { ':chat': chatId, ':now': this.now() });
    const instant = this.now();
    // For both legacy POST-time+3h fences and new calendar-end fences, subtracting
    // 3h identifies the sending window (each window is at least 6h). This is format
    // compatibility, not a rolling TTL. Keep uncertain sends fenced until its end.
    const claim = await this.db.run(`UPDATE poll_state SET owner_request_id=:request,
      phase='preparing',lease_until=:lease,updated_at=:now WHERE chat_id=:chat
      AND (owner_request_id IS NULL OR lease_until<:now)
      AND (unknown_until=0 OR unknown_until-10800<:window_start)`, {
      ':request': requestId, ':chat': chatId, ':lease': instant + 180, ':now': instant,
      ':window_start': pollWindow(instant).start,
    });
    const state = await this.getPollState(chatId);
    if (claim.rowsAffected === 1) return { status: 'claimed', state };
    return { status: state.owner_request_id && state.lease_until >= this.now() ? 'busy'
      : state.unknown_until > this.now() ? 'outcome_unknown' : 'busy' };
  }

  async renewPollRun(chatId, requestId) {
    const result = await this.db.run(`UPDATE poll_state SET lease_until=:lease,updated_at=:now
      WHERE chat_id=:chat AND owner_request_id=:request AND lease_until>=:now`, {
      ':chat': chatId, ':request': requestId, ':lease': this.now() + 180, ':now': this.now(),
    });
    if (result.rowsAffected !== 1) throw new Error('POLL_CONFLICT');
  }

  async preparePollPost(chatId, requestId) {
    const instant = this.now();
    const result = await this.db.run(`UPDATE poll_state SET phase='sending',unknown_until=:unknown,
      lease_until=:lease,updated_at=:now WHERE chat_id=:chat AND owner_request_id=:request AND lease_until>=:now`, {
      ':chat': chatId, ':request': requestId, ':unknown': pollWindow(instant).end,
      ':lease': instant + 180, ':now': instant,
    });
    if (result.rowsAffected !== 1) throw new Error('POLL_CONFLICT');
  }

  async recordPollPost(chatId, requestId, fresh, message) {
    if (!Number.isSafeInteger(message?.message_id) || message.message_id <= 0
      || (fresh && (typeof message.poll?.id !== 'string' || !message.poll.id))) throw new Error('POLL_RESPONSE_INVALID');
    const createdAt = Number.isSafeInteger(message.date) && message.date > 0 && message.date <= this.now()
      ? message.date : this.now();
    // A pin POST can succeed while its response is lost. Before replacing the
    // latest delivery, atomically retain that known bot ID for explicit cleanup
    // even if the recovery pin also failed. All RHS expressions see the old row.
    const result = await this.db.run(`UPDATE poll_state SET latest_message_id=:message,
      pending_unpin_ids=CASE WHEN latest_message_id IS NOT NULL AND latest_message_id<>:message
        AND (pinned_message_id IS NULL OR latest_message_id<>pinned_message_id)
        AND NOT EXISTS(SELECT 1 FROM json_each(pending_unpin_ids) WHERE value=latest_message_id)
        THEN json_insert(pending_unpin_ids,'$[#]',latest_message_id) ELSE pending_unpin_ids END,
      original_message_id=CASE WHEN :fresh=1 THEN :message ELSE original_message_id END,
      poll_id=CASE WHEN :fresh=1 THEN :poll ELSE poll_id END,
      created_at=CASE WHEN :fresh=1 THEN :created ELSE created_at END,
      phase='pinning',unknown_until=0,lease_until=:lease,updated_at=:now
      WHERE chat_id=:chat AND owner_request_id=:request`, {
      ':chat': chatId, ':request': requestId, ':message': message.message_id, ':fresh': fresh ? 1 : 0,
      ':poll': message.poll?.id ?? null, ':created': createdAt, ':lease': this.now() + 180, ':now': this.now(),
    });
    if (result.rowsAffected !== 1) throw new Error('POLL_CONFLICT');
  }

  async updatePollPins(chatId, requestId, pinnedMessageId, pendingUnpinIds) {
    if ((pinnedMessageId != null && (!Number.isSafeInteger(pinnedMessageId) || pinnedMessageId <= 0))
      || !Array.isArray(pendingUnpinIds) || pendingUnpinIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('POLL_INPUT_INVALID');
    }
    const result = await this.db.run(`UPDATE poll_state SET pinned_message_id=:pinned,
      pending_unpin_ids=:pending,lease_until=:lease,updated_at=:now
      WHERE chat_id=:chat AND owner_request_id=:request AND lease_until>=:now`, {
      ':chat': chatId, ':request': requestId, ':pinned': pinnedMessageId ?? null,
      ':pending': JSON.stringify([...new Set(pendingUnpinIds)]), ':lease': this.now() + 180, ':now': this.now(),
    });
    if (result.rowsAffected !== 1) throw new Error('POLL_CONFLICT');
  }

  async clearPollPostFence(chatId, requestId) {
    const result = await this.db.run(`UPDATE poll_state SET unknown_until=0,phase='preparing',updated_at=:now
      WHERE chat_id=:chat AND owner_request_id=:request`, {
      ':chat': chatId, ':request': requestId, ':now': this.now(),
    });
    if (result.rowsAffected !== 1) throw new Error('POLL_CONFLICT');
  }

  async finishPollRun(chatId, requestId, status) {
    const instant = this.now();
    await this.db.run(`UPDATE poll_state SET owner_request_id=NULL,lease_until=0,
      phase=CASE WHEN unknown_until<>0 AND unknown_until-10800>=:window_start
        THEN 'unknown' ELSE 'idle' END,updated_at=:now
      WHERE chat_id=:chat AND owner_request_id=:request`, {
      ':chat': chatId, ':request': requestId, ':now': instant,
      ':window_start': pollWindow(instant).start,
    });
    await this.db.run(`UPDATE poll_requests SET status=:status,updated_at=:now
      WHERE request_id=:request AND chat_id=:chat`, {
      ':chat': chatId, ':request': requestId, ':status': status, ':now': this.now(),
    });
  }

  async cleanup() {
    // Seven days for transient public reports; dedup tombstones retained 30 days.
    await this.db.run('DELETE FROM report_jobs WHERE updated_at<:cutoff', { ':cutoff': this.now() - 7 * 86400 });
    await this.db.run('DELETE FROM deliveries WHERE updated_at<:cutoff', { ':cutoff': this.now() - 30 * 86400 });
    await this.db.run('DELETE FROM poll_requests WHERE updated_at<:cutoff', { ':cutoff': this.now() - 30 * 86400 });
  }
}
