# Dokploy AI Enhancement - Implementation Tasks

> Generated: 2025-12-19
> Based on: `docs/AI-Enhancement-Design.md` vs Current Implementation

---

## Task Overview

| Priority | Category | Tasks | Status |
|----------|----------|-------|--------|
| P0 | Backend | 2 | Pending |
| P1 | Frontend | 2 | Pending |
| P2 | Frontend | 2 | Pending |
| P3 | Infra | 1 | Pending |

---

## P0 - Critical (Must Have)

### Task 1: Implement Agent Orchestrator State Machine

**Design Reference:** Section 5.1

**Problem:**
The design specifies a state machine for multi-step agent tasks, but no implementation exists.

**Required States:**
```
IDLE → PLANNING → WAIT_APPROVAL → EXECUTING → VERIFYING → COMPLETED/FAILED/CANCELLED
```

**Files to Create/Modify:**
- [ ] `packages/server/src/services/ai/agent/orchestrator.ts` (new)
- [ ] `packages/server/src/services/ai.ts` (integrate orchestrator)

**Implementation Checklist:**
- [ ] Create `AgentOrchestrator` class with state machine
- [ ] Implement `start(goal, ctx)` - create run, generate plan
- [ ] Implement `execute(runId)` - execute plan steps sequentially
- [ ] Implement `approve(executionId, approved)` - handle user approval
- [ ] Implement `cancel(runId)` - cancel running agent
- [ ] Implement `getStatus(runId)` - return current state
- [ ] Add state transition validation
- [ ] Integrate with `aiRuns` and `aiToolExecutions` tables

**Acceptance Criteria:**
- Agent can execute multi-step plans
- Dangerous operations pause for approval
- State transitions are persisted to database
- Cancellation stops execution gracefully

---

### Task 2: Implement Dynamic Tool Selection

**Design Reference:** Section 2.3

**Problem:**
Currently `toolRegistry.getAll()` returns all tools. This causes context overflow with 50+ tools.

**Files to Create/Modify:**
- [ ] `packages/server/src/services/ai-tools/selector.ts` (new)
- [ ] `packages/server/src/services/ai.ts` (use selector in chatStream)

**Implementation Checklist:**
- [ ] Create `selectRelevantTools(userMessage, context)` function
- [ ] Implement intent classification (can use simple keyword matching or LLM)
- [ ] Always include base query tools (list_*, get_*)
- [ ] Add category-specific tools based on intent
- [ ] Filter by user permissions
- [ ] Limit to 15-30 tools per request

**Intent Categories:**
```typescript
type Intent =
  | 'query'        // "show me", "list", "status"
  | 'application'  // "deploy", "restart", "logs"
  | 'database'     // "backup", "restore", "create db"
  | 'domain'       // "add domain", "ssl", "certificate"
  | 'server'       // "server metrics", "docker"
```

**Acceptance Criteria:**
- Tool count per request: 15-30 (not 50+)
- Relevant tools selected based on user message
- Query tools always available

---

## P1 - High (Should Have)

### Task 3: Fix SSE Tool Call Parameter Handling

**Design Reference:** Section 6.3

**Problem:**
`use-chat.ts` ignores tool arguments from SSE events, hardcoding to `"{}"`.

**File:** `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts`

**Current Code (Line 217-238):**
```typescript
if (evt.event === "tool-call") {
  const payload = JSON.parse(evt.data) as { toolCallId: string; toolName: string };
  // ❌ Missing: arguments from payload
  function: { name: payload.toolName, arguments: "{}" }
}
```

**Required Changes:**
- [ ] Update backend `stream.ts` to include `arguments` in tool-call event
- [ ] Update frontend to parse and display arguments

**Backend Change (`pages/api/ai/stream.ts:98-100`):**
```typescript
onToolCall: (toolCallId, toolName, args) => {
  writeSseEvent(res, "tool-call", { toolCallId, toolName, arguments: args });
},
```

**Frontend Change (`use-chat.ts`):**
```typescript
const payload = JSON.parse(evt.data) as {
  toolCallId: string;
  toolName: string;
  arguments?: string;
};
// Use payload.arguments instead of "{}"
```

**Acceptance Criteria:**
- Tool parameters display immediately (not after refetch)
- Arguments match what AI requested

---

### Task 4: Implement Real-time Tool Result Updates

**Design Reference:** Section 6.3

**Problem:**
`tool-result` SSE event is ignored. UI only updates after `refetchMessages()`.

**File:** `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts`

**Current Code (Line 241-243):**
```typescript
if (evt.event === "tool-result") {
  // Empty - relies on refetchMessages
}
```

**Required Changes:**
- [ ] Parse tool-result event payload
- [ ] Update corresponding toolCall status in pendingMessages
- [ ] Display result immediately

**Implementation:**
```typescript
if (evt.event === "tool-result") {
  const payload = JSON.parse(evt.data) as {
    toolCallId: string;
    toolName: string;
    result: { success: boolean; message?: string; data?: unknown; error?: string };
  };
  // Update toolCall status to 'completed' or 'failed'
  // Store result for display
}
```

**Acceptance Criteria:**
- Tool results appear immediately after execution
- No need to wait for refetchMessages
- Error states display correctly

---

## P2 - Medium (Nice to Have)

### Task 5: Create Agent Status Panel Component

**Design Reference:** Section 6.1, 6.3 Pattern C

**Problem:**
No UI for visualizing multi-step agent plans and execution progress.

**Files to Create:**
- [ ] `apps/dokploy/components/dashboard/ai-assistant/agent-status-panel.tsx`
- [ ] `apps/dokploy/components/dashboard/ai-assistant/plan-step.tsx`

**Component Props:**
```typescript
interface AgentStatusPanelProps {
  runId: string;
  status: 'pending' | 'planning' | 'waiting_approval' | 'executing' | 'completed' | 'failed';
  goal: string;
  plan?: {
    steps: Array<{
      toolName: string;
      description: string;
      status: 'pending' | 'executing' | 'completed' | 'failed';
      requiresApproval: boolean;
    }>;
  };
  currentStep?: number;
  onApprove?: () => void;
  onCancel?: () => void;
}
```

**UI Requirements:**
- Display goal at top
- List all steps with status indicators
- Highlight current executing step
- Show approve/cancel buttons when waiting_approval
- Progress bar or step indicator

**Acceptance Criteria:**
- Users can see full execution plan
- Current step is clearly indicated
- Approval workflow is intuitive

---

### Task 6: Create Resource Card Component

**Design Reference:** Section 6.2

**Problem:**
Tool results display as raw JSON. Need rich cards for resources.

**Files to Create:**
- [ ] `apps/dokploy/components/dashboard/ai-assistant/resource-card.tsx`

**Component Props:**
```typescript
interface ResourceCardProps {
  type: 'application' | 'database' | 'server' | 'domain' | 'certificate';
  resource: {
    id: string;
    name: string;
    status: string;
    // type-specific fields
  };
  actions?: Array<{
    label: string;
    onClick: () => void;
    variant?: 'default' | 'destructive';
  }>;
}
```

**UI Requirements:**
- Icon based on resource type
- Status badge (Running/Stopped/Error)
- Key metrics or info
- Quick action buttons
- Link to full resource page

**Acceptance Criteria:**
- Applications show: name, status, last deploy time
- Databases show: name, type, status, size
- Servers show: name, status, CPU/Memory metrics

---

## P3 - Low (Future Enhancement)

### Task 7: Add Tool Categories

**Design Reference:** Section 2.2

**Problem:**
Current tool categories are limited. Design specifies 5 categories.

**File:** `packages/server/src/services/ai-tools/types.ts`

**Current Categories:**
- application, database, server, compose, domain, backup, certificate, project, environment

**Required Categories (per design):**
- `query` - Read-only operations (list_*, get_*, status)
- `application` - App management (deploy, stop, restart)
- `database` - DB operations (create, backup, restore)
- `monitoring` - Metrics, health checks, logs
- `automation` - Scheduled tasks, webhooks

**Changes:**
- [ ] Update `Tool` interface category type
- [ ] Classify existing tools into new categories
- [ ] Add `monitoring` and `automation` tool files

---

## Infrastructure Tasks

### Task 8: Fix Codex Bridge Encoding Issue

**Problem:**
`codex_bridge.py` fails on Windows with `UnicodeEncodeError: 'gbk' codec can't encode character`

**File:** `C:\Users\admin\.claude\skills\collaborating-with-codex\scripts\codex_bridge.py`

**Fix:**
```python
# Add at top of file, after imports
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')
```

**Alternative:** Set environment variable before running:
```bash
set PYTHONIOENCODING=utf-8
```

---

## File Reference

| Module | Path |
|--------|------|
| DB Schema | `packages/server/src/db/schema/ai.ts` |
| Tool Registry | `packages/server/src/services/ai-tools/registry.ts` |
| Tool Types | `packages/server/src/services/ai-tools/types.ts` |
| AI Service | `packages/server/src/services/ai.ts` |
| API Router | `apps/dokploy/server/api/routers/ai.ts` |
| SSE Endpoint | `apps/dokploy/pages/api/ai/stream.ts` |
| Chat Hook | `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts` |
| Tool Block | `apps/dokploy/components/dashboard/ai-assistant/tool-call-block.tsx` |
| Chat Drawer | `apps/dokploy/components/dashboard/ai-assistant/ai-chat-drawer.tsx` |

---

## Progress Tracking

- [ ] P0-Task1: Agent Orchestrator State Machine
- [ ] P0-Task2: Dynamic Tool Selection
- [ ] P1-Task3: SSE Tool Call Parameter Handling
- [ ] P1-Task4: Real-time Tool Result Updates
- [ ] P2-Task5: Agent Status Panel Component
- [ ] P2-Task6: Resource Card Component
- [ ] P3-Task7: Add Tool Categories
- [ ] Infra-Task8: Fix Codex Bridge Encoding

---

*Document Version: 1.0*
*Last Updated: 2025-12-19*
