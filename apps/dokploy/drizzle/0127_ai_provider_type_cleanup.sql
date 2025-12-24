UPDATE "ai" SET "providerType" = 'openai_compatible' WHERE "providerType" = 'auto';
ALTER TABLE "ai" ALTER COLUMN "providerType" SET DEFAULT 'openai_compatible';
