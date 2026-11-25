CREATE TABLE `organize_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`mode` text NOT NULL,
	`node_ids` text,
	`columns` text NOT NULL,
	`reason` text NOT NULL,
	`changed` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`operation_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `organize_proposals_status_created` ON `organize_proposals` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `organize_proposals_session_status` ON `organize_proposals` (`session_id`,`status`);