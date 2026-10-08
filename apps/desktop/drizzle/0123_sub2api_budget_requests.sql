CREATE TABLE `sub2api_budget_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`responses_url` text NOT NULL,
	`credential_generation` text NOT NULL,
	`client_request_id` text,
	`response_id` text,
	`message_client_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`amount` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sub2api_budget_receipt_identity` ON `sub2api_budget_requests` (`owner_id`,`provider_id`,`responses_url`,`client_request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `sub2api_budget_message_identity` ON `sub2api_budget_requests` (`owner_id`,`session_id`,`message_client_id`);--> statement-breakpoint
CREATE INDEX `sub2api_budget_pending` ON `sub2api_budget_requests` (`owner_id`,`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `sub2api_budget_response` ON `sub2api_budget_requests` (`owner_id`,`session_id`,`response_id`);