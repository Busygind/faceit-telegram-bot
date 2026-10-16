CREATE TABLE `report_cache` (
	`cache_key` text PRIMARY KEY NOT NULL,
	`scope_hash` text NOT NULL,
	`kind` text NOT NULL,
	`report_json` text NOT NULL,
	`file_id` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_report_cache_expiry` ON `report_cache` (`expires_at`);
