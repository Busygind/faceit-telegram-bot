import { table, integer, text, index, uniqueIndex } from 'sdk/db';

export const chatSettings = table('chat_settings', {
  chatId: integer('chat_id').primaryKey(),
  originChatId: integer('origin_chat_id').notNull(),
  ciphertext: text('ciphertext'),
  version: integer('version').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

export const deliveries = table('deliveries', {
  requestId: text('request_id').primaryKey(),
  chatId: integer('chat_id').notNull(),
  topicId: integer('topic_id'),
  kind: text('kind').notNull(),
  status: text('status').notNull(),
  messageId: integer('message_id'),
  pollId: text('poll_id'),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({ updated: index('idx_deliveries_updated').on(t.updatedAt) }));

export const reportJobs = table('report_jobs', {
  jobId: text('job_id').primaryKey(),
  chatId: integer('chat_id').notNull(),
  topicId: integer('topic_id'),
  state: text('state').notNull(),
  status: text('status').notNull(),
  version: integer('version').notNull(),
  leaseUntil: integer('lease_until').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({ updated: index('idx_jobs_updated').on(t.updatedAt) }));

// sdk/db documents uniqueIndex rather than a table-level composite primary key.
export const playerLinks = table('player_links', {
  chatId: integer('chat_id').notNull(),
  userId: integer('user_id').notNull(),
  playerId: text('player_id').notNull(),
  nickname: text('nickname').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({ owner: uniqueIndex('idx_player_links_chat_user').on(t.chatId, t.userId) }));
