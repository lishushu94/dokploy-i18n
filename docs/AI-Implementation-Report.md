# Dokploy AI Enhancement 实施报告

## 概述

本报告记录了 Dokploy AI Assistant 增强功能的完整实施过程，包括实现细节、代码审查发现和修复措施。

---

## 1. 任务清单与完成状态

| 任务ID | 任务名称 | 优先级 | 状态 |
|--------|----------|--------|------|
| P0-Task1 | Agent Orchestrator 状态机 | P0 | ✅ 完成 |
| P0-Task2 | 动态工具选择 | P0 | ✅ 完成 |
| P1-Task3 | SSE工具调用参数修复 | P1 | ✅ 完成 |
| P1-Task4 | 实时工具结果更新 | P1 | ✅ 完成 |
| P2-Task5 | Agent状态面板组件 | P2 | ✅ 完成 |
| P2-Task6 | 资源卡片组件 | P2 | ✅ 完成 |
| P3-Task7 | 工具分类元数据 | P3 | ✅ 完成 |
| Infra-Task8 | Codex/Gemini编码修复 | Infra | ✅ 完成 |

---

## 2. 实现详情

### 2.1 P0-Task1: Agent Orchestrator 状态机

**新建文件**: `packages/server/src/services/ai/agent/orchestrator.ts`

**实现内容**:
- 状态机设计: `IDLE → PLANNING → WAIT_APPROVAL → EXECUTING → VERIFYING → COMPLETED/FAILED/CANCELLED`
- 状态转换验证函数 `assertValidTransition()`
- 核心编排函数 `orchestrateRun()` - 执行多步骤计划
- 辅助函数: `cancelRun()`, `approveExecution()`, `rejectExecution()`, `getRunStatus()`

**类型定义**:
```typescript
export type AgentOrchestratorState =
  | "IDLE" | "PLANNING" | "WAIT_APPROVAL" | "EXECUTING"
  | "VERIFYING" | "COMPLETED" | "FAILED" | "CANCELLED";

export type AgentPlanStep = {
  id: string;
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
};
```

### 2.2 P0-Task2: 动态工具选择

**新建文件**: `packages/server/src/services/ai-tools/selector.ts`

**实现内容**:
- 意图分类函数 `classifyIntent()` - 识别 query/application/database/domain/server
- 数据库类型检测 `detectDatabasePrefixes()`
- 工具评分算法 `scoreTool()` - 基于名称匹配、风险等级、操作类型
- 工具排序 `rankTools()`
- 主函数 `selectRelevantTools()` - 将50+工具筛选至15-25个

**选择策略**:
```typescript
// 根据意图添加相关前缀
if (intent === "application") {
  prefixes.add("application.");
  prefixes.add("compose.");
}
if (intent === "database") {
  // 检测具体数据库类型或添加所有数据库前缀
}
```

### 2.3 P1-Task3: SSE工具调用参数修复

**修改文件**:
- `packages/server/src/services/ai.ts`
- `apps/dokploy/pages/api/ai/stream.ts`

**问题**: `onToolCall` 回调缺少 `args` 参数，前端无法获取工具调用参数

**修复**:
```typescript
// ai.ts - ChatStreamOptions 类型
onToolCall?: (toolCallId: string, toolName: string, args: unknown) => void;

// stream.ts - SSE 事件
onToolCall: (toolCallId, toolName, args) => {
  writeSseEvent(res, "tool-call", { toolCallId, toolName, arguments: args });
},
```

### 2.4 P1-Task4: 实时工具结果更新

**修改文件**: `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts`

**问题**: `tool-result` SSE 事件被忽略，UI 需要等待 `refetchMessages` 才能更新

**修复**:
```typescript
// 扩展 ToolCall 接口
export interface ToolCall {
  id: string;
  type: "function";
  status?: "pending" | "approved" | "rejected" | "executing" | "completed" | "failed";
  executionId?: string;
  result?: { success: boolean; message?: string; data?: unknown; error?: string };
  function: { name: string; arguments: string };
}

// 处理 tool-result 事件
if (evt.event === "tool-result") {
  const payload = JSON.parse(evt.data);
  setPendingMessages((prev) => /* 更新对应 toolCall 的状态和结果 */);
}
```

### 2.5 P2-Task5: Agent状态面板组件

**新建文件**: `apps/dokploy/components/dashboard/ai-assistant/agent-status-panel.tsx`

**组件功能**:
- 显示 Agent 执行目标和当前状态
- 进度条可视化
- 步骤列表 (pending/in-progress/completed/failed 状态图标)
- 审批/取消按钮

### 2.6 P2-Task6: 资源卡片组件

**新建文件**: `apps/dokploy/components/dashboard/ai-assistant/resource-card.tsx`

**组件功能**:
- 资源类型图标 (application/database/server/domain/certificate)
- 状态徽章 (running/active/stopped/error)
- 详情网格显示
- 操作下拉菜单

### 2.7 P3-Task7: 工具分类元数据

**新建文件**: `packages/server/src/services/ai-tools/categories.ts`

**实现内容**:
```typescript
export interface ToolCategory {
  id: string;
  name: string;
  icon: string;
  description: string;
  displayOrder: number;
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  project: { id: "project", name: "Project Management", icon: "folder", ... },
  application: { id: "application", name: "Applications", icon: "app-window", ... },
  // ... 14 个分类
};
```

**Registry 扩展**:
- `getAllWithCategories()` - 获取带分类信息的工具列表
- `getByCategoryWithInfo()` - 按分类获取工具

### 2.8 Infra-Task8: Bridge编码修复

**修改文件**:
- `C:\Users\admin\.claude\skills\collaborating-with-codex\scripts\codex_bridge.py`
- `C:\Users\admin\.claude\skills\collaborating-with-gemini\scripts\gemini_bridge.py`

**修复内容**:
```python
# 设置环境变量
env = os.environ.copy()
env['PYTHONIOENCODING'] = 'utf-8'
env['PYTHONUTF8'] = '1'

# 添加错误处理
process = subprocess.Popen(
    ...,
    encoding='utf-8',
    errors='replace',  # 替换无法解码的字符
    env=env,
)
```

---

## 3. 代码审查发现

### 3.1 审查执行

使用 **Codex** 对后端实现进行代码审查，使用 **Gemini** 对前端组件进行审查。

### 3.2 Codex 审查发现 (orchestrator.ts)

#### 严重问题 (已修复)

**问题1: 非审批步骤永远不会执行**

```typescript
// 原代码 - createExecutionForStep() 设置非审批步骤为 "executing"
status: step.requiresApproval ? "pending" : "executing",

// 但 orchestrateRun() 只在 "approved" 分支执行工具
if (execStatus === "approved") {
  // 执行工具...
}

// 当看到 "executing" 状态时直接返回
if (execStatus === "executing") {
  return { state: "EXECUTING", runId };  // 永远不会真正执行
}
```

**修复**: 将非审批步骤初始状态改为 `"approved"`

---

**问题2: 工具执行异常导致DB状态不一致**

```typescript
// 原代码 - 无 try/catch
const result = await toolRegistry.execute(...);
// 如果抛出异常，execution 和 run 状态不会更新
```

**修复**: 添加 try/catch 包装
```typescript
let result: ToolResult;
try {
  result = await toolRegistry.execute(...);
} catch (error) {
  await updateExecution(exec.executionId, { status: "failed", error: ... });
  await updateRun(runId, { status: "failed", error: ... });
  return { state: "FAILED", runId, error: errorMessage };
}
```

---

**问题3: 取消状态返回错误**

```typescript
// 原代码
if (verifyingRun?.status !== "cancelled") {
  // 更新为 completed
}
return { state: "COMPLETED", runId };  // 即使已取消也返回 COMPLETED

// 修复后
if (verifyingRun?.status === "cancelled") {
  return { state: "CANCELLED", runId };
}
```

#### 警告级问题 (建议后续处理)

1. **竞态条件: 重复创建执行记录** - 并发调用 `orchestrateRun()` 可能重复插入同一 `executionId`
2. **竞态条件: 重复执行** - 两个调用者可能同时看到 `"approved"` 状态并执行工具
3. **取消检测不完整** - 仅检查 `abortSignal`，DB 中的取消状态在执行过程中不会被检测到

### 3.3 Codex 审查发现 (selector.ts)

1. **`projectId` 未使用** - 接受但从未使用该参数
2. **默认工具数量偏高** - `minTools=15, maxTools=25` 可能过多
3. **子串匹配可能误判** - `messageLower.includes(ns)` 可能匹配子串 (如 "host" 匹配 "ghost")

### 3.4 Codex 审查发现 (use-chat.ts)

1. **状态推断可能有损** - 默认为 `"completed"` 即使 payload 格式不匹配
2. **JSON.parse 无容错** - 单个格式错误的 SSE 帧会导致整个流失败

---

## 4. 文件变更摘要

### 新建文件 (6个)

| 文件路径 | 行数 | 说明 |
|----------|------|------|
| `packages/server/src/services/ai/agent/orchestrator.ts` | 345 | Agent 状态机 |
| `packages/server/src/services/ai-tools/selector.ts` | 161 | 动态工具选择 |
| `packages/server/src/services/ai-tools/categories.ts` | 85 | 工具分类元数据 |
| `apps/dokploy/.../agent-status-panel.tsx` | 113 | Agent 状态面板 |
| `apps/dokploy/.../resource-card.tsx` | 140 | 资源卡片组件 |

### 修改文件 (6个)

| 文件路径 | 变更类型 |
|----------|----------|
| `packages/server/src/services/ai.ts` | 集成 selector, 修改 buildSystemPrompt |
| `packages/server/src/services/ai-tools/registry.ts` | 新增分类方法 |
| `packages/server/src/services/ai-tools/index.ts` | 导出 categories |
| `apps/dokploy/pages/api/ai/stream.ts` | SSE 事件添加 arguments |
| `apps/dokploy/.../use-chat.ts` | 扩展 ToolCall, 处理 tool-result |
| `codex_bridge.py` / `gemini_bridge.py` | 编码修复 |

---

## 5. 后续建议

### 高优先级

1. 为 `orchestrateRun()` 添加数据库事务或乐观锁，解决竞态条件
2. 在 `use-chat.ts` 中为每个 `JSON.parse` 添加 try/catch

### 中优先级

1. 利用 `projectId` 参数进一步缩小工具范围
2. 调整默认工具数量或根据意图置信度动态调整

### 低优先级

1. 使用更精确的正则匹配替代 `includes()` 子串匹配
2. 添加单元测试覆盖状态机转换逻辑

---

## 6. 审查模型使用

| 阶段 | 模型 | 用途 |
|------|------|------|
| Phase 2 分析 | Codex + Gemini | 多角度方案设计 |
| Phase 5 审计 | Codex | 后端代码审查 (发现3个严重问题) |
| Phase 5 审计 | Gemini | 前端组件审查 (超时) |

---

*报告生成时间: 2025-12-19*
