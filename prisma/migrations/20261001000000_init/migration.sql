-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "support_requests" (
    "key" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "conversation_dom" TEXT NOT NULL,
    "requester_id" TEXT NOT NULL,
    "requester_dom" TEXT NOT NULL,
    "requester_name" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "status_category" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'fault',
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "last_seen_reply_at" TIMESTAMP(3),
    "last_message_id" TEXT,
    "last_message_sha256" TEXT,
    "last_message_at" TIMESTAMP(3),
    "assignee_account_id" TEXT,
    "assignee_seen_at" TIMESTAMP(3),
    "agent_conversation_at" TIMESTAMP(3),
    "agent_conversation_id" TEXT,
    "agent_conversation_dom" TEXT,
    "agent_conversation_left_at" TIMESTAMP(3),

    CONSTRAINT "support_requests_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_dom" TEXT NOT NULL,
    "conversation_id" TEXT,
    "conversation_dom" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "details" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_config" (
    "channel_id" TEXT NOT NULL,
    "organisation_id" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_config_pkey" PRIMARY KEY ("channel_id")
);

-- CreateIndex
CREATE INDEX "support_requests_conversation_id_conversation_dom_idx" ON "support_requests"("conversation_id", "conversation_dom");

