import { integer, text, sqliteTable, index } from 'drizzle-orm/sqlite-core';
export const chatSettings = sqliteTable('chat_settings', {
  chat_id: integer('chat_id').primaryKey(), origin_chat_id: integer('origin_chat_id').notNull(),
  ciphertext: text('ciphertext'), version: integer('version').notNull().default(0), updated_at: integer('updated_at').notNull(),
});
export const deliveries = sqliteTable('deliveries', {
  request_id: text('request_id').primaryKey(), chat_id: integer('chat_id').notNull(), topic_id: integer('topic_id'),
  kind: text('kind').notNull(), status: text('status').notNull(), message_id: integer('message_id'), poll_id: text('poll_id'), updated_at: integer('updated_at').notNull(),
}, table => [index('idx_deliveries_updated').on(table.updated_at)]);
export const reportJobs = sqliteTable('report_jobs', {
  job_id: text('job_id').primaryKey(), chat_id: integer('chat_id').notNull(), topic_id: integer('topic_id'),
  state: text('state').notNull(), status: text('status').notNull(), version: integer('version').notNull(),
  lease_until: integer('lease_until').notNull().default(0), updated_at: integer('updated_at').notNull(),
}, table => [index('idx_jobs_updated').on(table.updated_at)]);
export const reportCache = sqliteTable('report_cache', {
  cache_key: text('cache_key').primaryKey(), scope_hash: text('scope_hash').notNull(), kind: text('kind').notNull(),
  report_json: text('report_json').notNull(), file_id: text('file_id'), created_at: integer('created_at').notNull(), expires_at: integer('expires_at').notNull(),
}, table => [index('idx_report_cache_expiry').on(table.expires_at)]);
