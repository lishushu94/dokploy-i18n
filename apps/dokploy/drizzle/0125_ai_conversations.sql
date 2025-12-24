-- AI Conversation System Migration
-- Creates tables for AI conversations, messages, runs, and tool executions

-- Create enums
DO $$ BEGIN
    CREATE TYPE "public"."aiConversationStatus" AS ENUM('active', 'archived');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "public"."aiMessageRole" AS ENUM('user', 'assistant', 'system', 'tool');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "public"."aiRunStatus" AS ENUM('pending', 'planning', 'waiting_approval', 'executing', 'verifying', 'completed', 'failed', 'cancelled');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "public"."aiToolExecutionStatus" AS ENUM('pending', 'approved', 'rejected', 'executing', 'completed', 'failed');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create ai_conversation table
CREATE TABLE IF NOT EXISTS "ai_conversation" (
    "conversationId" text PRIMARY KEY NOT NULL,
    "organizationId" text NOT NULL,
    "userId" text NOT NULL,
    "aiId" text,
    "title" text,
    "projectId" text,
    "serverId" text,
    "status" "aiConversationStatus" DEFAULT 'active' NOT NULL,
    "metadata" jsonb,
    "createdAt" text NOT NULL,
    "updatedAt" text NOT NULL
);

-- Create ai_message table
CREATE TABLE IF NOT EXISTS "ai_message" (
    "messageId" text PRIMARY KEY NOT NULL,
    "conversationId" text NOT NULL,
    "role" "aiMessageRole" NOT NULL,
    "content" text,
    "toolCalls" jsonb,
    "toolCallId" text,
    "toolName" text,
    "promptTokens" integer,
    "completionTokens" integer,
    "createdAt" text NOT NULL
);

-- Create ai_run table
CREATE TABLE IF NOT EXISTS "ai_run" (
    "runId" text PRIMARY KEY NOT NULL,
    "conversationId" text NOT NULL,
    "status" "aiRunStatus" DEFAULT 'pending' NOT NULL,
    "goal" text NOT NULL,
    "plan" jsonb,
    "result" jsonb,
    "error" text,
    "startedAt" text,
    "completedAt" text,
    "createdAt" text NOT NULL
);

-- Create ai_tool_execution table
CREATE TABLE IF NOT EXISTS "ai_tool_execution" (
    "executionId" text PRIMARY KEY NOT NULL,
    "runId" text,
    "messageId" text,
    "toolName" text NOT NULL,
    "parameters" jsonb,
    "result" jsonb,
    "status" "aiToolExecutionStatus" DEFAULT 'pending' NOT NULL,
    "requiresApproval" boolean DEFAULT false NOT NULL,
    "approvedBy" text,
    "approvedAt" text,
    "startedAt" text,
    "completedAt" text,
    "error" text,
    "createdAt" text NOT NULL
);

-- Add foreign key constraints
DO $$ BEGIN
    ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_organizationId_organization_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_aiId_ai_aiId_fk" FOREIGN KEY ("aiId") REFERENCES "public"."ai"("aiId") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_projectId_project_projectId_fk" FOREIGN KEY ("projectId") REFERENCES "public"."project"("projectId") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_conversation" ADD CONSTRAINT "ai_conversation_serverId_server_serverId_fk" FOREIGN KEY ("serverId") REFERENCES "public"."server"("serverId") ON DELETE set null ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_message" ADD CONSTRAINT "ai_message_conversationId_ai_conversation_conversationId_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."ai_conversation"("conversationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_run" ADD CONSTRAINT "ai_run_conversationId_ai_conversation_conversationId_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."ai_conversation"("conversationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_tool_execution" ADD CONSTRAINT "ai_tool_execution_runId_ai_run_runId_fk" FOREIGN KEY ("runId") REFERENCES "public"."ai_run"("runId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    ALTER TABLE "ai_tool_execution" ADD CONSTRAINT "ai_tool_execution_messageId_ai_message_messageId_fk" FOREIGN KEY ("messageId") REFERENCES "public"."ai_message"("messageId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS "ai_conversation_organizationId_idx" ON "ai_conversation" ("organizationId");
CREATE INDEX IF NOT EXISTS "ai_conversation_userId_idx" ON "ai_conversation" ("userId");
CREATE INDEX IF NOT EXISTS "ai_conversation_status_idx" ON "ai_conversation" ("status");
CREATE INDEX IF NOT EXISTS "ai_message_conversationId_idx" ON "ai_message" ("conversationId");
CREATE INDEX IF NOT EXISTS "ai_run_conversationId_idx" ON "ai_run" ("conversationId");
CREATE INDEX IF NOT EXISTS "ai_tool_execution_runId_idx" ON "ai_tool_execution" ("runId");
CREATE INDEX IF NOT EXISTS "ai_tool_execution_messageId_idx" ON "ai_tool_execution" ("messageId");
