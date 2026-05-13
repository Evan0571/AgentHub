# 架构速查（与 PRD §6 对应）

## 仓库分层

```
agenthub/
├── apps/
│   ├── web/      — Next.js 15 前端（聊天 UI / Diff / Plan / Preview / Deploy）
│   └── server/   — NestJS 后端（Conversation / Orchestrator / Workspace / Sandbox / Deploy）
├── packages/
│   ├── shared-types/         — 前后端共享的协议 & 领域类型（零依赖）
│   ├── adapter-core/         — AgentAdapter 接口 + middleware + registry
│   ├── adapter-mock/         — 演示兜底（不烧 token）
│   ├── adapter-claude-code/  — Anthropic / Claude Code 实现（stub）
│   ├── adapter-codex/        — OpenAI / Codex 实现（stub）
│   ├── adapter-doubao/       — 火山方舟豆包实现（stub）
│   ├── db/                   — Drizzle ORM schema
│   └── prompts/              — 角色 system prompt 模板库
├── infra/                    — docker-compose（postgres / redis / minio）
└── docs/                     — PRD / 架构 / 演示脚本
```

## 关键模块依赖图

```
            web ─────────WebSocket / REST─────────► server
             │                                      │
             └────import───────► shared-types ◄─────┘
                                       ▲
                                       │
                                  adapter-core
                              ▲     ▲     ▲     ▲
                              │     │     │     │
                           mock claude codex doubao
```

## 评分支点 → 代码位置

| 评分维度 | 位置 |
|---------|------|
| **AgentAdapter 抽象** | `packages/adapter-core/src/types.ts` |
| **中间件链** | `packages/adapter-core/src/middleware.ts`（withLogging / withRetry / withCache） |
| **Capability-aware 调度** | `packages/adapter-core/src/registry.ts` (`findByCapability`) |
| **@ 路由 + hop 限制** | `apps/server/src/conversation/mention-router.ts` |
| **Orchestrator DAG** | `apps/server/src/orchestrator/{planner,executor,critic,plan}.service.ts` |
| **人工编辑 Plan**（§5.5.4） | `apps/server/src/orchestrator/plan.service.ts` (`applyEdits` + 乐观锁 + 环检测) |
| **群聊回放**（§F2.7） | `apps/server/src/conversation/replay.service.ts` |
| **匿名预览分享**（§F7.6） | `apps/server/src/sandbox/share-link.service.ts` (HMAC token + TTL) |
| **Workspace 不可变快照** | `apps/server/src/workspace/snapshot.service.ts` |

## 端到端典型请求（参考 PRD §6.3）

```
User → WS user_msg(@arch)
  → ConversationGateway
  → MentionRouter (resolve adapter, set hop)
  → AgentAdapter.chat() ── stream ──► ChatEvent
  → translate to ServerEvent (msg_token / patch / done)
  → WS push to client
```

带 Orchestrator 的复杂请求：

```
User → WS user_msg(@orchestrator "做待办App")
  → OrchestratorService.plan()
  → PlannerService.draft() → Plan(DAG)
  → server_event: plan_update
  → ExecutorService.run() (topo + parallel ≤3)
      ├── 同层并行: adapter.chat() per task
      ├── CriticService.judge() per task
      └── replanner on failure (max retries=2)
  → server_event: msg_token / patch / plan_update ...
```
