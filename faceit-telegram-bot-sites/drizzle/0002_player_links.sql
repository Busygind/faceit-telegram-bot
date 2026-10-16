CREATE TABLE `player_links` (
	`chat_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`player_id` text NOT NULL,
	`nickname` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_player_links_chat_user` ON `player_links` (`chat_id`,`user_id`);
