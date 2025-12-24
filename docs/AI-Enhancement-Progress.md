# Dokploy AI Enhancement - Implementation Progress

## Current Status: Phase 4 Complete (Service Management Tools)

### Completed Features

#### Phase 1: Basic Chat (Previously Completed)
- Database Schema (`packages/server/src/db/schema/ai.ts`)
- Backend Services (`packages/server/src/services/ai.ts`)
- tRPC Routes (`apps/dokploy/server/api/routers/ai.ts`)
- Frontend Components (`apps/dokploy/components/dashboard/ai-assistant/`)

#### Phase 2: Tool Calling System (Previously Completed)

##### 1. Tool System Architecture (`packages/server/src/services/ai-tools/`)
- `types.ts` - Tool interfaces (Tool, ToolContext, ToolResult, RiskLevel)
- `registry.ts` - ToolRegistry class for tool management
- `index.ts` - Exports and initialization

##### 2. Core Tools (`packages/server/src/services/ai-tools/tools/`)
| File | Tools | Risk Level |
|------|-------|------------|
| `postgres.ts` | `postgres.list`, `postgres.get`, `postgres.create`, `postgres.deploy`, `postgres.delete` | Low-High |
| `application.ts` | `application.list`, `application.get`, `application.create`, `application.deploy`, `application.restart`, `application.status` | Low-Medium |
| `server.ts` | `server.list`, `server.get`, `server.status` | Low |
| `project.ts` | `project.list`, `project.get`, `project.create`, `project.delete` | Low-High |
| `environment.ts` | `environment.list`, `environment.get`, `environment.create`, `environment.delete` | Low-High |

#### Phase 3: Additional Database Tools (Previously Completed)

##### New Database Tools Added
| File | Tools | Risk Level | Notes |
|------|-------|------------|-------|
| `mariadb.ts` | `mariadb.list`, `mariadb.get`, `mariadb.create`, `mariadb.deploy`, `mariadb.delete` | Low-High | Supports `databaseRootPassword` |
| `mysql.ts` | `mysql.list`, `mysql.get`, `mysql.create`, `mysql.deploy`, `mysql.delete` | Low-High | Supports `databaseRootPassword` |
| `mongo.ts` | `mongo.list`, `mongo.get`, `mongo.create`, `mongo.deploy`, `mongo.delete` | Low-High | Supports `replicaSets` option |
| `redis.ts` | `redis.list`, `redis.get`, `redis.create`, `redis.deploy`, `redis.delete` | Low-High | Password-only auth |

##### Key Improvements Over Original Tools
- Correct `projectId` filtering using in-memory filter on `environment.project.projectId`
- Enhanced parameter support (passwords, replicaSets)
- Technology-specific field handling (e.g., Redis has no `databaseName`)

#### Phase 4: Service Management Tools (Just Completed)

##### Compose Tools (`compose.ts`)
| Tool | Description | Risk Level |
|------|-------------|------------|
| `compose.list` | List all Compose services with optional project/environment filter | Low |
| `compose.get` | Get Compose service details | Low |
| `compose.create` | Create new Docker Compose or Swarm Stack service | Medium |
| `compose.deploy` | Deploy/Redeploy a Compose service | Medium |
| `compose.start` | Start a stopped service | Medium |
| `compose.stop` | Stop a running service | Medium |
| `compose.delete` | Delete a Compose service permanently | High |

##### Domain Tools (`domain.ts`)
| Tool | Description | Risk Level |
|------|-------------|------------|
| `domain.list` | List domains filtered by Application or Compose ID | Low |
| `domain.create` | Attach a domain to Application or Compose service | Medium |
| `domain.delete` | Remove a domain | High |
| `domain.check` | Validate DNS resolution for a domain | Low |

##### Backup Tools (`backup.ts`)
| Tool | Description | Risk Level |
|------|-------------|------------|
| `backup.list` | List backup schedules filtered by database or compose ID | Low |
| `backup.get` | Get backup schedule details | Low |
| `backup.create` | Create a backup schedule for database | Medium |
| `backup.delete` | Delete a backup schedule | High |

##### Certificate Tools (`certificate.ts`)
| Tool | Description | Risk Level |
|------|-------------|------------|
| `certificate.list` | List certificates filtered by organization | Low |
| `certificate.create` | Upload/Create a new SSL certificate | Medium |
| `certificate.delete` | Delete a certificate | High |

##### 3. Backend Updates
- `ai.ts` - `chat()` function now integrates with Vercel AI SDK `tool()` for tool calling
- `ai.ts` - Added `executeApprovedTool()` for executing approved tools
- `ai.ts` - Updated `buildSystemPrompt()` to include available tools
- `ai.ts` - Tool executions are recorded in `aiToolExecutions` table

##### 4. API Updates (`apps/dokploy/server/api/routers/ai.ts`)
- `api.ai.agent.execute` - Execute an approved tool
- `api.ai.agent.getExecution` - Get tool execution details

##### 5. Frontend Updates (`apps/dokploy/components/dashboard/ai-assistant/`)
- `use-chat.ts` - Added `ToolCall` interface and updated `Message` type
- `message-bubble.tsx` - Updated to display tool calls inline
- `tool-call-block.tsx` - New component for tool call display with:
  - Tool name and parameters display
  - Status indicators (pending, executing, completed, failed)
  - Approval dialog for dangerous operations
  - Result display

---

## How Tool Calling Works

1. **User sends message** → `chat()` receives request
2. **AI generates response** → May include tool calls via Vercel AI SDK
3. **Low-risk tools** → Execute immediately, return results
4. **High-risk tools** → Return `pending_approval` status
5. **User approves** → Call `api.ai.agent.approve` then `api.ai.agent.execute`
6. **Results displayed** → ToolCallBlock shows execution status and results

---

## Next Phase: UI Polish & Testing

### UI Improvements
- Real-time streaming for long operations
- Better error messages and retry UX
- ~~Tool execution history view~~ ✅ Completed (`tool-execution-history.tsx`)

### Testing
- Integration tests for new tools
- End-to-end testing of tool approval flow

---

## Development Environment

### Database Connection
```
PostgreSQL running on port 5433
DATABASE_URL=postgres://dokploy:dokploy123@localhost:5433/dokploy
```

### Start Development Server
```powershell
cd E:\APP\dokploy-i18n\apps\dokploy
$env:DATABASE_URL="postgres://dokploy:dokploy123@localhost:5433/dokploy"
npx pnpm dev
```

### Push Schema Changes
```powershell
cd E:\APP\dokploy-i18n\apps\dokploy
$env:DATABASE_URL="postgres://dokploy:dokploy123@localhost:5433/dokploy"
npx drizzle-kit push --config ./server/db/drizzle.config.ts
```

---

## File Summary

### New Files Created
```
packages/server/src/services/ai-tools/
├── index.ts
├── registry.ts
├── types.ts
└── tools/
    ├── postgres.ts
    ├── mariadb.ts
    ├── mysql.ts
    ├── mongo.ts
    ├── redis.ts
    ├── application.ts
    ├── server.ts
    ├── project.ts       # Core tool
    ├── environment.ts   # Core tool
    ├── compose.ts       # Phase 4
    ├── domain.ts        # Phase 4
    ├── backup.ts        # Phase 4
    └── certificate.ts   # Phase 4

apps/dokploy/components/dashboard/ai-assistant/
├── tool-call-block.tsx
└── tool-execution-history.tsx
```

### Modified Files
```
packages/server/src/services/ai.ts
packages/server/src/services/ai-tools/index.ts  # Updated to register new tools
apps/dokploy/server/api/routers/ai.ts
apps/dokploy/components/dashboard/ai-assistant/use-chat.ts
apps/dokploy/components/dashboard/ai-assistant/message-bubble.tsx
```

---

## Resume Instructions

To test the implementation:

> "Help me test the AI tool calling system. Start the development server and try asking the AI to list projects, environments, Compose services or domains."

To add more tools:

> "Read `docs/AI-Enhancement-Progress.md` for context. Add [specific tool category] tools next."

---

## Code Review Notes (Phase 4)

### Implementation Decisions
- `compose.list` uses in-memory `projectId` filtering (same pattern as database tools)
- `domain.create` requires either `applicationId` or `composeId`
- `backup.create` handles multiple database types via dynamic ID mapping
- `certificate.create` accepts raw certificate and private key data

### Known Limitations
- No `organizationId` scoping in list operations (consistent with existing pattern)
- Certificate private keys stored as-is (matches existing service behavior)
- Backup tool only supports database backups (not compose volume backups)

---

## Bug Fixes

### 2024-12 AI Chat Display Issues

#### Symptoms
1. **看不到AI回复** - 用户发送消息后，AI的流式响应不显示
2. **重复的"发送中"指示器** - 发送消息时出现多个加载指示器

#### Root Cause Analysis

| 问题 | 根因 | 位置 |
|------|------|------|
| 看不到AI回复 | `MessageBubble` 的打字机效果使用 `setTimeout`，但流式传输时 `content` 快速更新导致 `useEffect` 不断清理 timeout，`displayedContent` 永远无法更新 | `message-bubble.tsx:33-51` |
| 重复"发送中" | `AIChatDrawer` 的 `{isLoading && ...}` 块与 `MessageBubble` 对 `status: "sending"` 消息的 Loader2 同时显示 | `ai-chat-drawer.tsx:197-207` + `message-bubble.tsx:123-125` |

#### Fixes Applied

**1. 移除多余的加载指示器** (`ai-chat-drawer.tsx`)

删除了第 197-207 行的 `{isLoading && ...}` 块：

```tsx
// REMOVED:
{isLoading && (
  <div className="flex gap-3 p-4">
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
      <Bot className="h-4 w-4 text-muted-foreground" />
    </div>
    <div className="flex items-center gap-2 text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="text-sm">{t("ai.chat.thinking")}</span>
    </div>
  </div>
)}
```

**2. 修复流式传输内容显示** (`message-bubble.tsx:45-49`)

添加了流式传输时直接更新内容的逻辑，跳过打字机效果：

```tsx
// ADDED after line 43:
// During streaming, update content directly without typewriter effect
if (isSending) {
  setDisplayedContent(content);
  return;
}
```

**3. 简化光标显示条件** (`message-bubble.tsx:102-104`)

修复了审计发现的光标消失问题：

```tsx
// BEFORE:
{isSending && displayedContent.length < (message.content?.length || 0) && (
  <span className="inline-block w-1 h-3 ml-1 bg-current animate-pulse"/>
)}

// AFTER:
{isSending && (
  <span className="inline-block w-1 h-3 ml-1 bg-current animate-pulse"/>
)}
```

#### Technical Notes

- 打字机效果仅在消息完成后（`status !== "sending"`）才应用
- 流式传输期间直接同步显示内容，确保用户能实时看到AI响应
- 光标在 `isSending` 状态时始终显示，提供视觉反馈

#### Audit Notes (Gemini Review)

- ✅ 逻辑正确性验证通过
- ⚠️ 如果后端 TTFT (Time To First Token) 延迟较高，用户可能缺少"思考中"的反馈（仅有发送按钮的 loading 状态）
- 如需恢复等待提示，可在 `use-chat.ts` 中添加一个空内容的 placeholder 消息

