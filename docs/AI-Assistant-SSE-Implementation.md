# AI Assistant SSE 流式传输实现进度

## 概述

本文档记录 AI Assistant 从伪流式传输升级为真实 SSE (Server-Sent Events) 流式传输的实现进度。

---

## 已完成的工作

### Phase 1: 后端 SSE 流式传输

**文件:** `packages/server/src/services/ai.ts`

- ✅ 添加 `streamText` 导入（替代 `generateText` 用于流式）
- ✅ 创建 `ChatStreamOptions` 类型定义
- ✅ 实现 `chatStream()` 函数，支持：
  - 实时文本流式传输
  - Tool call/result 事件
  - AbortSignal 支持
  - 授权验证（aiId 和 conversationId 的组织权限检查）
  - 错误处理和隔离
  - 自动标题生成

### Phase 2: SSE API 端点

**文件:** `apps/dokploy/pages/api/ai/stream.ts` (新建)

- ✅ 创建 Next.js API 路由处理 SSE
- ✅ 实现 SSE 响应头设置
- ✅ 处理以下事件类型：
  - `delta` - 文本增量
  - `tool-call` - 工具调用
  - `tool-result` - 工具结果
  - `done` - 完成
  - `error` - 错误
- ✅ 用户认证和组织权限验证

### Phase 3: 前端 SSE 消费

**文件:** `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts`

- ✅ 实现 `readSseStream()` 异步生成器函数
- ✅ 添加 `AbortController` 状态管理
- ✅ 实现 `stopGeneration()` 函数
- ✅ 添加 `useEffect` 清理（组件卸载时中止请求）
- ✅ 更新 `send()` 函数使用 fetch + SSE 替代 tRPC
- ✅ 处理 `delta`, `done`, `error`, `stream-error` 事件
- ✅ Message 接口添加 `error` 字段

### Phase 4: UI 增强

**文件:** `apps/dokploy/components/dashboard/ai-assistant/message-bubble.tsx`

- ✅ 导入 `AlertTriangle` 图标
- ✅ 优化流式动画（3字符/10ms）
- ✅ 增强错误显示（左边框 + 详细错误信息）
- ✅ 更新 `displayedContent` 初始化逻辑

**文件:** `apps/dokploy/components/dashboard/ai-assistant/tool-execution-history.tsx`

- ✅ 添加 `CheckCircle2` 图标
- ✅ 改进视觉层次（圆形图标容器、悬停效果）

---

## 安全修复（代码审计）

根据 Codex 和 Gemini 的代码审计，已修复以下问题：

1. **aiId 授权漏洞** - 添加 `aiSettings.organizationId !== organizationId` 检查
2. **conversationId 授权漏洞** - 添加对话组织权限验证
3. **流消费稳定性** - 用 try/catch 包装 `for await` 循环
4. **回调错误隔离** - 隔离回调错误防止影响主流程
5. **客户端取消支持** - 添加 AbortController + 组件卸载清理
6. **stream-error 事件处理** - 添加 `stream-error` 事件检测

---

## 已知问题

### 1. UI 显示 "undefined"
- **状态:** 待调查
- **描述:** AI 助手界面显示 undefined
- **可能原因:**
  - 数据类型不匹配
  - API 响应解析问题
  - 状态初始化问题

### 2. 其他 UI 问题
- **状态:** 待调查
- **描述:** 用户报告的其他 UI 问题

---

## 关键文件清单

| 文件路径 | 状态 | 描述 |
|---------|------|------|
| `packages/server/src/services/ai.ts` | ✅ 已修改 | 后端 SSE 流式服务 |
| `apps/dokploy/pages/api/ai/stream.ts` | ✅ 新建 | SSE API 端点 |
| `apps/dokploy/components/dashboard/ai-assistant/use-chat.ts` | ✅ 已修改 | 前端 SSE 消费 Hook |
| `apps/dokploy/components/dashboard/ai-assistant/message-bubble.tsx` | ✅ 已修改 | 消息气泡组件 |
| `apps/dokploy/components/dashboard/ai-assistant/tool-execution-history.tsx` | ✅ 已修改 | 工具执行历史组件 |

---

## 测试状态

从服务器日志确认：
- ✅ SSE 端点编译成功 (`Compiling /api/ai/stream`)
- ✅ SSE 请求成功响应 (`POST /api/ai/stream 200`)
- ✅ 对话创建成功 (`POST /api/trpc/ai.conversations.create`)
- ✅ 消息检索成功 (`GET /api/trpc/ai.chat.messages`)

---

## 下一步

1. 调试 "undefined" 显示问题
2. 检查前端状态管理
3. 验证 SSE 事件解析逻辑
4. 完善错误处理和重试机制
5. 添加国际化支持

---

## 技术栈

- **后端:** Vercel AI SDK (`streamText`), tRPC, Drizzle ORM
- **前端:** React Hooks, Fetch API, SSE
- **数据库:** PostgreSQL
- **框架:** Next.js 15
