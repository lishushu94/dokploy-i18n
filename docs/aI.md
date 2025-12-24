
● 让我检查前端是否正确处理工具调用事件。

● Read(apps\dokploy\components\dashboard\ai-assistant\use-chat.ts)
  ⎿  Read 80 lines

● 发现问题！前端 use-chat.ts 没有处理 tool-call 和 tool-result SSE 事件。让我检查 message-bubble.tsx 是否能正确显示工具调用。

● Read(apps\dokploy\components\dashboard\ai-assistant\tool-call-block.tsx)
  ⎿  Read 243 lines

● ---
  AI 工具调用端点审阅报告

  架构概览

  ┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
  │   Frontend      │────▶│  /api/ai/stream  │────▶│  ai.ts           │
  │   use-chat.ts   │ SSE │  (Next.js API)   │     │  chatStream()    │
  └─────────────────┘     └──────────────────┘     └──────────────────┘
                                                            │
                                                            ▼
                                                   ┌──────────────────┐
                                                   │  toolRegistry    │
                                                   │  (13 tool files) │
                                                   └──────────────────┘

  工具注册状态 ✅

  | 工具文件       | 注册函数                   | 工具数量                      |
  |----------------|----------------------------|-------------------------------|
  | project.ts     | registerProjectTools()     | 4 (list, get, create, delete) |
  | environment.ts | registerEnvironmentTools() | 4                             |
  | postgres.ts    | registerPostgresTools()    | 5                             |
  | mysql.ts       | registerMysqlTools()       | 5                             |
  | mariadb.ts     | registerMariadbTools()     | 5                             |
  | mongo.ts       | registerMongoTools()       | 5                             |
  | redis.ts       | registerRedisTools()       | 5                             |
  | application.ts | registerApplicationTools() | 6                             |
  | server.ts      | registerServerTools()      | 3                             |
  | compose.ts     | registerComposeTools()     | 7                             |
  | domain.ts      | registerDomainTools()      | 4                             |
  | backup.ts      | registerBackupTools()      | 4                             |
  | certificate.ts | registerCertificateTools() | 3                             |

  AI 工具可见性 ✅

  System Prompt 构建 (ai.ts:805-839):
  const toolList = toolRegistry.getAll()
    .map((t) => `- ${t.name}: ${t.description} (Risk: ${t.riskLevel}...)`)
    .join("\n");

  AI 可以看到完整的工具列表及其描述、风险等级。

  API 端点状态 ✅

  | 端点                      | 功能           | 状态        |
  |---------------------------|----------------|-------------|
  | /api/ai/stream            | SSE 流式聊天   | ✅ 工作正常 |
  | api.ai.agent.approve      | 批准工具执行   | ✅ 已实现   |
  | api.ai.agent.execute      | 执行已批准工具 | ✅ 已实现   |
  | api.ai.agent.getExecution | 获取执行详情   | ✅ 已实现   |

  ⚠️ 发现的问题

  前端 SSE 事件处理不完整 (use-chat.ts:196-233)

  后端发送的事件:
  - delta ✅ 处理
  - done ✅ 处理
  - error / stream-error ✅ 处理
  - tool-call ❌ 未处理
  - tool-result ❌ 未处理

  影响: 工具调用不会在流式传输时实时显示，需要等 refetchMessages 后才能看到。

  工具调用流程

  1. AI 生成工具调用 → Vercel AI SDK 处理
  2. 低风险工具 → 立即执行，返回结果
  3. 高风险工具 → 返回 pending_approval，等待用户批准
  4. 消息保存 → toolCalls 字段保存到数据库
  5. 前端刷新 → refetchMessages 获取完整消息（含工具调用）

  结论

  | 检查项         | 状态                  |
  |----------------|-----------------------|
  | AI 能看到工具  | ✅ 通过 system prompt |
  | AI 能调用工具  | ✅ 通过 Vercel AI SDK |
  | 工具能被执行   | ✅ 后端正确处理       |
  | 工具调用能显示 | ⚠️ 可用但非实时       |

  建议: 如需实时显示工具调用进度，可在 use-chat.ts 中添加 tool-call 和 tool-result 事件处理。
