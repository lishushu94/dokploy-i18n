# Dokploy AI Enhancement System - Technical Design Document

## Executive Summary

This document outlines the comprehensive design for enhancing Dokploy's AI capabilities from a simple project recommendation system to a full-featured AI assistant that can manage the entire PaaS platform through natural language.

**Current State:** Single `suggestVariants()` function using `generateObject`
**Target State:** Hybrid conversational + Agent mode with Tool Calling, covering 500+ API endpoints

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Frontend Layer                               │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────────┐ │
│  │  Chat Drawer    │  │  Agent Panel    │  │  Confirmation       │ │
│  │  (Slide-over)   │  │  (Task Monitor) │  │  Dialogs            │ │
│  └────────┬────────┘  └────────┬────────┘  └──────────┬──────────┘ │
└───────────┼────────────────────┼─────────────────────┼─────────────┘
            │                    │                     │
            ▼                    ▼                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         API Layer (tRPC)                             │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ai.chat.*  │  ai.conversations.*  │  ai.agent.*  │ ai.tools.* │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AI Service Layer                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  AI Gateway  │──│ Tool Registry │──│  Agent Orchestrator      │  │
│  │  (Provider   │  │ (Dynamic     │  │  (State Machine +        │  │
│  │   Abstraction│  │  Selection)  │  │   Execution Engine)      │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    Existing Dokploy Services                         │
│  application │ compose │ postgres │ mysql │ mongo │ redis │ docker │
│  server │ cluster │ backup │ domain │ certificate │ notification   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Backend Architecture

### 2.1 AI Gateway Layer

The AI Gateway provides a unified interface for multiple AI providers while handling provider-specific configurations.

**Location:** `packages/server/src/services/ai/gateway.ts`

```typescript
// Core Gateway Interface
interface AIGatewayConfig {
  provider: AIProvider;
  model: string;
  temperature?: number;
  maxTokens?: number;
  tools?: AITool[];
  toolChoice?: 'auto' | 'required' | { type: 'tool'; toolName: string };
}

interface AIGatewayResponse {
  text?: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool-calls' | 'length' | 'error';
  usage: { promptTokens: number; completionTokens: number };
}
```

### 2.2 Tool Registry System

The Tool Registry manages all available AI tools, organized by capability groups.

**Location:** `packages/server/src/services/ai/tools/`

```
packages/server/src/services/ai/tools/
├── index.ts              # Tool registry & dynamic selection
├── registry.ts           # Tool registration logic
├── types.ts              # Common types
├── application/          # Application management tools
│   ├── deploy.ts
│   ├── stop.ts
│   ├── restart.ts
│   ├── logs.ts
│   └── index.ts
├── database/             # Database operation tools
│   ├── postgres.ts
│   ├── mysql.ts
│   ├── mongo.ts
│   ├── redis.ts
│   ├── backup.ts
│   └── index.ts
├── monitoring/           # Monitoring & diagnostics tools
│   ├── metrics.ts
│   ├── health.ts
│   ├── logs.ts
│   └── index.ts
├── automation/           # Automation tools
│   ├── schedule.ts
│   ├── webhook.ts
│   └── index.ts
└── query/                # Query-only tools (safe)
    ├── list.ts
    ├── status.ts
    └── index.ts
```

**Tool Definition Structure:**

```typescript
interface AITool {
  name: string;
  description: string;
  category: 'application' | 'database' | 'monitoring' | 'automation' | 'query';
  riskLevel: 'safe' | 'moderate' | 'dangerous';
  requiresApproval: boolean;
  parameters: z.ZodSchema;
  execute: (params: unknown, ctx: ExecutionContext) => Promise<ToolResult>;
}

interface ExecutionContext {
  organizationId: string;
  userId: string;
  permissions: string[];
  conversationId: string;
  runId?: string;
}
```

### 2.3 Dynamic Tool Selection

To prevent context overflow, tools are dynamically selected based on user intent (5-30 tools per request, not all 500+).

```typescript
// Tool selection based on user intent
async function selectRelevantTools(
  userMessage: string,
  conversationContext: ConversationContext
): Promise<AITool[]> {
  // 1. Always include query tools (safe, read-only)
  const basTools = toolRegistry.getByCategory('query');

  // 2. Intent classification
  const intent = await classifyIntent(userMessage);

  // 3. Add category-specific tools
  const categoryTools = toolRegistry.getByCategories(intent.categories);

  // 4. Context-aware filtering
  const contextTools = filterByContext(categoryTools, conversationContext);

  // 5. Permission filtering
  return filterByPermissions(contextTools, conversationContext.permissions);
}
```

### 2.4 tRPC Server-Side Caller Pattern

To reuse existing tRPC procedures within AI tools:

```typescript
// packages/server/src/services/ai/tools/application/deploy.ts
import { appRouter } from '@dokploy/server/api/root';

export const deployTool: AITool = {
  name: 'deploy_application',
  description: 'Deploy or redeploy an application',
  category: 'application',
  riskLevel: 'moderate',
  requiresApproval: true,
  parameters: z.object({
    applicationId: z.string().describe('The application ID to deploy'),
  }),
  execute: async (params, ctx) => {
    const caller = appRouter.createCaller({
      session: await getSessionForOrganization(ctx.organizationId),
      db,
    });

    const result = await caller.application.deploy({
      applicationId: params.applicationId,
    });

    return {
      success: true,
      message: `Deployment started for application ${params.applicationId}`,
      data: result,
    };
  },
};
```

---

## 3. Database Schema Extensions

**Location:** `packages/server/src/db/schema/ai.ts`

### 3.1 New Tables

```typescript
// Conversation table
export const aiConversations = pgTable("ai_conversation", {
  conversationId: text("conversationId").primaryKey().$defaultFn(() => nanoid()),
  organizationId: text("organizationId").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: text("userId").notNull(),
  title: text("title"),

  // Context anchors for scoping
  projectId: text("projectId").references(() => projects.projectId),
  environmentId: text("environmentId"),
  serverId: text("serverId").references(() => server.serverId),

  status: text("status", { enum: ["active", "archived"] }).notNull().default("active"),
  metadata: json("metadata").$type<Record<string, unknown>>(),

  createdAt: text("createdAt").$defaultFn(() => new Date().toISOString()),
  updatedAt: text("updatedAt").$defaultFn(() => new Date().toISOString()),
});

// Message table
export const aiMessages = pgTable("ai_message", {
  messageId: text("messageId").primaryKey().$defaultFn(() => nanoid()),
  conversationId: text("conversationId").notNull().references(() => aiConversations.conversationId, { onDelete: "cascade" }),

  role: text("role", { enum: ["user", "assistant", "system", "tool"] }).notNull(),
  content: text("content"),

  // Tool-related fields
  toolCalls: json("toolCalls").$type<ToolCall[]>(),
  toolCallId: text("toolCallId"),
  toolName: text("toolName"),

  // Token tracking
  promptTokens: integer("promptTokens"),
  completionTokens: integer("completionTokens"),

  createdAt: text("createdAt").$defaultFn(() => new Date().toISOString()),
});

// Agent run table (for multi-step tasks)
export const aiRuns = pgTable("ai_run", {
  runId: text("runId").primaryKey().$defaultFn(() => nanoid()),
  conversationId: text("conversationId").notNull().references(() => aiConversations.conversationId, { onDelete: "cascade" }),

  status: text("status", {
    enum: ["pending", "planning", "waiting_approval", "executing", "verifying", "completed", "failed", "cancelled"]
  }).notNull().default("pending"),

  goal: text("goal").notNull(),
  plan: json("plan").$type<AgentPlan>(),
  result: json("result").$type<AgentResult>(),
  error: text("error"),

  startedAt: text("startedAt"),
  completedAt: text("completedAt"),
  createdAt: text("createdAt").$defaultFn(() => new Date().toISOString()),
});

// Tool execution records
export const aiToolExecutions = pgTable("ai_tool_execution", {
  executionId: text("executionId").primaryKey().$defaultFn(() => nanoid()),
  runId: text("runId").references(() => aiRuns.runId, { onDelete: "cascade" }),
  messageId: text("messageId").references(() => aiMessages.messageId, { onDelete: "cascade" }),

  toolName: text("toolName").notNull(),
  parameters: json("parameters"),
  result: json("result"),

  status: text("status", { enum: ["pending", "approved", "rejected", "executing", "completed", "failed"] }).notNull(),
  requiresApproval: boolean("requiresApproval").notNull().default(false),
  approvedBy: text("approvedBy"),
  approvedAt: text("approvedAt"),

  startedAt: text("startedAt"),
  completedAt: text("completedAt"),
  error: text("error"),

  createdAt: text("createdAt").$defaultFn(() => new Date().toISOString()),
});
```

### 3.2 Relations

```typescript
export const aiConversationsRelations = relations(aiConversations, ({ many, one }) => ({
  messages: many(aiMessages),
  runs: many(aiRuns),
  organization: one(organization, {
    fields: [aiConversations.organizationId],
    references: [organization.id],
  }),
  project: one(projects, {
    fields: [aiConversations.projectId],
    references: [projects.projectId],
  }),
}));

export const aiMessagesRelations = relations(aiMessages, ({ one, many }) => ({
  conversation: one(aiConversations, {
    fields: [aiMessages.conversationId],
    references: [aiConversations.conversationId],
  }),
  toolExecutions: many(aiToolExecutions),
}));
```

---

## 4. API Routing Structure

**Location:** `apps/dokploy/server/api/routers/ai.ts`

### 4.1 Router Organization

```typescript
export const aiRouter = createTRPCRouter({
  // Settings management (existing)
  settings: aiSettingsRouter,

  // Conversation management
  conversations: createTRPCRouter({
    list: protectedProcedure.query(...),
    get: protectedProcedure.input(z.object({ conversationId: z.string() })).query(...),
    create: protectedProcedure.input(z.object({ title: z.string().optional(), projectId: z.string().optional() })).mutation(...),
    archive: protectedProcedure.input(z.object({ conversationId: z.string() })).mutation(...),
    delete: protectedProcedure.input(z.object({ conversationId: z.string() })).mutation(...),
  }),

  // Chat operations
  chat: createTRPCRouter({
    send: protectedProcedure.input(z.object({
      conversationId: z.string(),
      message: z.string(),
      aiId: z.string(),
    })).mutation(...),

    // Streaming endpoint using tRPC subscription
    stream: protectedProcedure.input(z.object({
      conversationId: z.string(),
      message: z.string(),
      aiId: z.string(),
    })).subscription(...),
  }),

  // Agent operations
  agent: createTRPCRouter({
    start: protectedProcedure.input(z.object({
      conversationId: z.string(),
      goal: z.string(),
      aiId: z.string(),
    })).mutation(...),

    getRun: protectedProcedure.input(z.object({ runId: z.string() })).query(...),
    cancel: protectedProcedure.input(z.object({ runId: z.string() })).mutation(...),

    // Approval for dangerous operations
    approve: protectedProcedure.input(z.object({
      executionId: z.string(),
      approved: z.boolean(),
    })).mutation(...),
  }),

  // Tool introspection
  tools: createTRPCRouter({
    list: protectedProcedure.query(...),
    getByCategory: protectedProcedure.input(z.object({ category: z.string() })).query(...),
  }),
});
```

---

## 5. Agent Execution Engine

### 5.1 State Machine

```
                    ┌─────────┐
                    │  IDLE   │
                    └────┬────┘
                         │ start(goal)
                         ▼
                    ┌─────────┐
            ┌───────│PLANNING │───────┐
            │       └────┬────┘       │
            │            │            │
            │ no approval│ approval   │ plan failed
            │ needed     │ needed     │
            ▼            ▼            ▼
       ┌─────────┐ ┌──────────────┐ ┌──────┐
       │EXECUTING│ │WAIT_APPROVAL │ │FAILED│
       └────┬────┘ └──────┬───────┘ └──────┘
            │             │
            │ approved    │ rejected
            │◄────────────┤─────────┐
            │             │         │
            ▼             │         ▼
       ┌─────────┐        │    ┌─────────┐
       │VERIFYING│        │    │CANCELLED│
       └────┬────┘        │    └─────────┘
            │             │
    ┌───────┴───────┐     │
    │               │     │
    ▼               ▼     │
┌─────────┐   ┌──────┐    │
│COMPLETED│   │FAILED│◄───┘
└─────────┘   └──────┘
```

### 5.2 Agent Orchestrator

```typescript
// packages/server/src/services/ai/agent/orchestrator.ts
interface AgentOrchestrator {
  start(params: StartParams): Promise<AgentRun>;
  execute(runId: string): Promise<void>;
  approve(executionId: string, approved: boolean): Promise<void>;
  cancel(runId: string): Promise<void>;
  getStatus(runId: string): Promise<AgentRunStatus>;
}

class AgentOrchestratorImpl implements AgentOrchestrator {
  async start({ conversationId, goal, aiId, ctx }: StartParams): Promise<AgentRun> {
    // 1. Create run record
    const run = await createRun({ conversationId, goal, status: 'planning' });

    // 2. Generate execution plan
    const plan = await this.generatePlan(goal, ctx);

    // 3. Store plan
    await updateRun(run.runId, { plan, status: 'pending' });

    // 4. Check if any step requires approval
    const needsApproval = plan.steps.some(s => s.requiresApproval);

    if (needsApproval) {
      await updateRun(run.runId, { status: 'waiting_approval' });
      return run;
    }

    // 5. Execute immediately if no approval needed
    this.executeAsync(run.runId, ctx);
    return run;
  }

  private async executeAsync(runId: string, ctx: ExecutionContext) {
    const run = await getRun(runId);
    await updateRun(runId, { status: 'executing', startedAt: new Date().toISOString() });

    try {
      for (const step of run.plan.steps) {
        // Execute tool
        const result = await this.executeTool(step, ctx);

        // Store execution record
        await createToolExecution({
          runId,
          toolName: step.toolName,
          parameters: step.parameters,
          result,
          status: 'completed',
        });

        // Verify result and decide next action
        const shouldContinue = await this.verifyAndDecide(run, step, result);
        if (!shouldContinue) break;
      }

      await updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() });
    } catch (error) {
      await updateRun(runId, { status: 'failed', error: error.message });
    }
  }
}
```

---

## 6. Frontend UX Design

### 6.1 Chat Interface (Slide-over Drawer)

**Location:** `apps/dokploy/components/dashboard/ai/`

```
┌────────────────────────────────────────────┐
│ Dashboard Content                          │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │                                      │  │
│  │                                      │  │
│  │                                      │  │
│  └──────────────────────────────────────┘  │
│                                            │
│                              ┌─────────────┤
│                              │ AI Assistant│
│                              │             │
│                              │ ┌─────────┐ │
│                              │ │Messages │ │
│                              │ │         │ │
│                              │ │         │ │
│                              │ └─────────┘ │
│                              │             │
│                              │ ┌─────────┐ │
│                              │ │ Input   │ │
│                              │ └─────────┘ │
│                              └─────────────┤
└────────────────────────────────────────────┘
```

**Component Structure:**

```
apps/dokploy/components/dashboard/ai/
├── ai-assistant.tsx           # Main container
├── chat-drawer.tsx            # Slide-over drawer
├── conversation-list.tsx      # Sidebar with conversations
├── message-list.tsx           # Message display
├── message-bubble.tsx         # Individual message
├── input-area.tsx             # Message input
├── tool-execution-card.tsx    # Tool execution display
├── confirmation-dialog.tsx    # Approval dialog
├── agent-status-panel.tsx     # Agent run status
└── hooks/
    ├── use-chat.ts            # Chat state management
    ├── use-agent.ts           # Agent state management
    └── use-conversations.ts   # Conversation list
```

### 6.2 Rich UI Cards

Different card types for different AI responses:

```typescript
// Tool execution card
interface ToolExecutionCardProps {
  toolName: string;
  parameters: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  result?: unknown;
  requiresApproval?: boolean;
  onApprove?: () => void;
  onReject?: () => void;
}

// Resource card (for displaying entities)
interface ResourceCardProps {
  type: 'application' | 'database' | 'server';
  resource: Resource;
  actions?: ResourceAction[];
}

// Confirmation card (for dangerous operations)
interface ConfirmationCardProps {
  operation: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  onConfirm: () => void;
  onCancel: () => void;
}
```

### 6.3 User Interaction Patterns

**Pattern A: Informational Query (No Approval)**
```
User: "What's the status of my blog application?"
AI: [Calls getApplicationStatus tool internally]
AI: "Your blog application is running healthy. Here's the summary:
    - Status: Running
    - CPU: 12%
    - Memory: 256MB / 512MB
    - Last deployment: 2 hours ago"
```

**Pattern B: Action with Confirmation (Moderate Risk)**
```
User: "Deploy my blog application"
AI: [Shows ConfirmationCard]
    "I'm ready to deploy your blog application.
    This will:
    - Pull latest code from main branch
    - Build with Nixpacks
    - Replace current running container

    [Confirm] [Cancel]"
User: [Clicks Confirm]
AI: [Executes deployment]
AI: "Deployment started! I'll notify you when it's complete."
```

**Pattern C: Agent Mode (Multi-step Task)**
```
User: "Set up a WordPress blog with MySQL database and SSL"
AI: [Creates agent run, shows AgentStatusPanel]
    "I've created an execution plan for you:

    Step 1: Create MySQL database
    Step 2: Create WordPress application
    Step 3: Configure database connection
    Step 4: Set up domain
    Step 5: Configure SSL certificate
    Step 6: Deploy application

    Some steps require your approval before execution.
    [Start Execution]"
```

---

## 7. Security Considerations

### 7.1 Permission Inheritance

AI tools inherit permissions from the user's session:

```typescript
interface ToolPermissionCheck {
  // Organization-level
  canManageOrganization: boolean;

  // Project-level (scoped by projectId in conversation)
  canDeployApplications: boolean;
  canManageDatabases: boolean;
  canViewLogs: boolean;
  canManageSecrets: boolean;

  // Server-level (scoped by serverId)
  canManageServer: boolean;
  canAccessDocker: boolean;
}
```

### 7.2 Dangerous Operation Confirmation

Operations classified as "dangerous" always require explicit user approval:

- **Dangerous operations:**
  - Delete application/database/project
  - Stop production services
  - Modify environment variables with secrets
  - Execute raw Docker commands
  - Scale down to zero replicas

- **Two-phase commit:**
  1. AI proposes action with full details
  2. User explicitly confirms in UI
  3. Execution proceeds only after confirmation

### 7.3 Audit Logging

All AI tool executions are logged:

```typescript
interface AIAuditLog {
  timestamp: string;
  userId: string;
  organizationId: string;
  conversationId: string;
  runId?: string;

  action: string;
  toolName: string;
  parameters: Record<string, unknown>;
  result: 'success' | 'failure' | 'rejected';

  ipAddress: string;
  userAgent: string;
}
```

---

## 8. Implementation Roadmap

### Phase 1: Foundation (Weeks 1-2)
- [ ] Database schema migrations
- [ ] AI Gateway abstraction
- [ ] Basic Tool Registry with 10 safe query tools
- [ ] Conversation CRUD APIs

### Phase 2: Chat Interface (Weeks 3-4)
- [ ] Chat drawer component
- [ ] Message streaming via tRPC subscription
- [ ] Basic tool execution display
- [ ] Conversation history UI

### Phase 3: Tool System (Weeks 5-6)
- [ ] Application management tools (deploy, stop, restart, logs)
- [ ] Database operation tools (CRUD, backup)
- [ ] Monitoring tools (metrics, health)
- [ ] Confirmation dialog for risky operations

### Phase 4: Agent Mode (Weeks 7-8)
- [ ] Agent orchestrator state machine
- [ ] Multi-step execution engine
- [ ] Plan generation and display
- [ ] Approval workflow UI

### Phase 5: Polish & Security (Weeks 9-10)
- [ ] Permission system integration
- [ ] Audit logging
- [ ] Error handling improvements
- [ ] Performance optimization
- [ ] Documentation

---

## 9. Tool Catalog

### 9.1 Query Tools (Safe)

| Tool Name | Description |
|-----------|-------------|
| `list_applications` | List all applications in project/organization |
| `get_application_status` | Get detailed status of an application |
| `list_databases` | List all databases |
| `get_database_status` | Get database status and metrics |
| `get_server_metrics` | Get server CPU/memory/disk metrics |
| `list_deployments` | List deployment history |
| `get_logs` | Get application/container logs |
| `list_domains` | List configured domains |
| `list_certificates` | List SSL certificates |
| `get_backup_status` | Get backup job status |

### 9.2 Application Tools (Moderate)

| Tool Name | Description | Requires Approval |
|-----------|-------------|-------------------|
| `deploy_application` | Deploy/redeploy application | Yes |
| `stop_application` | Stop running application | Yes |
| `restart_application` | Restart application | Yes |
| `rollback_deployment` | Rollback to previous version | Yes |
| `update_env_variable` | Update environment variable | Yes (if secret) |
| `scale_application` | Change replica count | Yes |

### 9.3 Database Tools (Moderate to Dangerous)

| Tool Name | Description | Requires Approval |
|-----------|-------------|-------------------|
| `create_database` | Create new database | Yes |
| `create_backup` | Create database backup | No |
| `restore_backup` | Restore from backup | Yes |
| `delete_database` | Delete database | Yes (Dangerous) |

### 9.4 Automation Tools

| Tool Name | Description | Requires Approval |
|-----------|-------------|-------------------|
| `create_scheduled_backup` | Set up scheduled backup | Yes |
| `configure_notification` | Set up notifications | No |
| `create_webhook` | Create webhook endpoint | Yes |

---

## 10. Example Conversations

### Example 1: Simple Query
```
User: "How many applications do I have running?"

AI: [Internal: calls list_applications tool]

AI: "You have 5 applications in your organization:
    - blog-frontend (Running)
    - blog-api (Running)
    - staging-app (Stopped)
    - docs-site (Running)
    - admin-panel (Running)

    4 are currently running and 1 is stopped."
```

### Example 2: Deployment with Confirmation
```
User: "Deploy my blog-frontend application"

AI: "I'll deploy your blog-frontend application. Here's what will happen:

    📦 Application: blog-frontend
    🔄 Build Type: Nixpacks
    🌿 Branch: main

    This will replace the currently running version.

    [Confirm Deployment] [Cancel]"

User: [Clicks Confirm]

AI: [Internal: calls deploy_application with approval]

AI: "✅ Deployment started for blog-frontend!

    Build ID: dep_abc123

    I'll monitor the progress. Current status: Building...

    [View Deployment Logs]"
```

### Example 3: Agent Mode
```
User: "Set up a new Next.js application with PostgreSQL database, configure the domain nextjs.example.com with SSL"

AI: "I've created an execution plan for this task:

    📋 Execution Plan

    Step 1: Create PostgreSQL database 'nextjs-db'
    Step 2: Create Next.js application from template
    Step 3: Configure DATABASE_URL environment variable
    Step 4: Add domain nextjs.example.com
    Step 5: Configure Let's Encrypt SSL certificate
    Step 6: Deploy application

    ⚠️ Steps 1, 2, 4, 5, 6 require your approval.

    [Review & Approve Steps] [Modify Plan] [Cancel]"

User: [Clicks Review & Approve Steps]

AI: [Shows detailed approval UI for each step]

[After approval and execution...]

AI: "✅ All steps completed successfully!

    Your Next.js application is now running at:
    https://nextjs.example.com

    Database: nextjs-db (PostgreSQL)
    SSL: Active (Let's Encrypt)

    [View Application] [View Logs]"
```

---

## Appendix A: Migration Script

```sql
-- Create ai_conversation table
CREATE TABLE ai_conversation (
    conversation_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    title TEXT,
    project_id TEXT REFERENCES projects(project_id),
    environment_id TEXT,
    server_id TEXT REFERENCES server(server_id),
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Create ai_message table
CREATE TABLE ai_message (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversation(conversation_id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT,
    tool_calls JSONB,
    tool_call_id TEXT,
    tool_name TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    created_at TEXT NOT NULL
);

-- Create ai_run table
CREATE TABLE ai_run (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES ai_conversation(conversation_id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    goal TEXT NOT NULL,
    plan JSONB,
    result JSONB,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL
);

-- Create ai_tool_execution table
CREATE TABLE ai_tool_execution (
    execution_id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES ai_run(run_id) ON DELETE CASCADE,
    message_id TEXT REFERENCES ai_message(message_id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    parameters JSONB,
    result JSONB,
    status TEXT NOT NULL,
    requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by TEXT,
    approved_at TEXT,
    started_at TEXT,
    completed_at TEXT,
    error TEXT,
    created_at TEXT NOT NULL
);

-- Indexes
CREATE INDEX idx_ai_conversation_org ON ai_conversation(organization_id);
CREATE INDEX idx_ai_conversation_user ON ai_conversation(user_id);
CREATE INDEX idx_ai_message_conversation ON ai_message(conversation_id);
CREATE INDEX idx_ai_run_conversation ON ai_run(conversation_id);
CREATE INDEX idx_ai_tool_execution_run ON ai_tool_execution(run_id);
```

---

*Document Version: 1.0*
*Last Updated: 2025-12-18*
*Authors: Claude (Anthropic), Codex (OpenAI), Gemini (Google)*
