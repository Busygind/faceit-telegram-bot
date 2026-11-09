CREATE TABLE `poll_state` (
  `chat_id` integer PRIMARY KEY NOT NULL,
  `original_message_id` integer,
  `poll_id` text,
  `created_at` integer,
  `latest_message_id` integer,
  `pinned_message_id` integer,
  `pending_unpin_ids` text DEFAULT '[]' NOT NULL,
  `owner_request_id` text,
  `phase` text DEFAULT 'idle' NOT NULL,
  `lease_until` integer DEFAULT 0 NOT NULL,
  `unknown_until` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `poll_requests` (
  `request_id` text PRIMARY KEY NOT NULL,
  `chat_id` integer NOT NULL,
  `status` text NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_poll_requests_updated` ON `poll_requests` (`updated_at`);
