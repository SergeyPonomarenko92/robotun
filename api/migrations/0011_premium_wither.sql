CREATE TABLE IF NOT EXISTS "admin_actions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_admin_id" uuid NOT NULL,
	"target_user_id" uuid,
	"target_aggregate_type" text,
	"target_aggregate_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_actor_admin_id_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_actions_actor" ON "admin_actions" USING btree ("actor_admin_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_actions_target_user" ON "admin_actions" USING btree ("target_user_id","created_at");