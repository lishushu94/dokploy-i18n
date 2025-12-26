-- Add conversationId to ai_tool_execution
ALTER TABLE "ai_tool_execution" ADD COLUMN IF NOT EXISTS "conversationId" text;

-- Backfill conversationId from ai_message when messageId is present
UPDATE "ai_tool_execution" AS e
SET "conversationId" = m."conversationId"
FROM "ai_message" AS m
WHERE e."conversationId" IS NULL
  AND e."messageId" IS NOT NULL
  AND m."messageId" = e."messageId";

-- Backfill conversationId from ai_run when runId is present
UPDATE "ai_tool_execution" AS e
SET "conversationId" = r."conversationId"
FROM "ai_run" AS r
WHERE e."conversationId" IS NULL
  AND e."runId" IS NOT NULL
  AND r."runId" = e."runId";

DO $$ BEGIN
    ALTER TABLE "ai_tool_execution" ADD CONSTRAINT "ai_tool_execution_conversationId_ai_conversation_conversationId_fk" FOREIGN KEY ("conversationId") REFERENCES "public"."ai_conversation"("conversationId") ON DELETE cascade ON UPDATE no action;
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE INDEX IF NOT EXISTS "ai_tool_execution_conversationId_idx" ON "ai_tool_execution" ("conversationId");
