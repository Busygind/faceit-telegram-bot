CREATE TABLE `chat_settings` (
	`chat_id` integer PRIMARY KEY NOT NULL,
	`origin_chat_id` integer NOT NULL,
	`ciphertext` text,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`request_id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`topic_id` integer,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`message_id` integer,
	`poll_id` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deliveries_updated` ON `deliveries` (`updated_at`);--> statement-breakpoint
CREATE TABLE `report_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`chat_id` integer NOT NULL,
	`topic_id` integer,
	`state` text NOT NULL,
	`status` text NOT NULL,
	`version` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_jobs_updated` ON `report_jobs` (`updated_at`);