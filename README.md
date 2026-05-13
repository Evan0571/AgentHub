# AgentHub

IM 聊天式的多 Agent 协作开发平台。详见 [`docs/PRD.md`](./docs/PRD.md)。

## 仓库结构

```
agenthub/
├── apps/
│   ├── web/                  Next.js 15 前端（聊天 UI / Diff / Preview / Plan Card）
│   └── server/               NestJS 后端（Conversation / Orchestrator / Workspace / Sandbox / Deploy）
├── packages/
│   ├── shared-types/         前后端共享的 WS 协议 & 领域类型
│   ├── adapter-core/         AgentAdapter 接口 / 中间件 / Registry
│   ├── adapter-mock/         本地回放适配器（演示兜底，不烧 token）
│   ├── adapter-claude-code/  Claude Code / Anthropic 适配器（stub）
│   ├── adapter-codex/        Codex / OpenAI 适配器（stub）
│   ├── adapter-doubao/       豆包 / 火山方舟适配器（stub）
│   ├── db/                   Drizzle ORM schema
│   └── prompts/              角色 system prompt 模板库
├── infra/                    docker-compose（postgres / redis / minio）
└── docs/                     PRD 与设计文档
```

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 启动基础设施（Postgres / Redis / MinIO）
docker compose -f infra/docker-compose.yml up -d

# 3. 准备环境变量
cp .env.example .env
# 编辑 .env，至少 Mock 模式可以零配置运行

# 4. 初始化数据库
pnpm db:push

# 5. 并行启动前后端
pnpm dev
```

- Web:    http://localhost:3000
- Server: http://localhost:4000
- MinIO 控制台: http://localhost:9001（admin / minioadmin）

## 演示模式（不烧 token）

设置 `SANDBOX_PROVIDER=mock` 并清空所有真 Adapter 的 API key，Mock Adapter 会从 `packages/adapter-mock/fixtures/` 回放固定的 demo 对话，适合赛事演示兜底。

## 评分支点对照

| 评分维度 | 关键实现位置 |
|---------|------------|
| 适配器层抽象 | `packages/adapter-core/src/types.ts`（AgentAdapter 接口契约） |
| Orchestrator | `apps/server/src/orchestrator/` |
| IM 隐喻 / @ 路由 | `apps/server/src/conversation/conversation.gateway.ts` + `mention-router.ts` |
| Diff / Workspace | `apps/server/src/workspace/` + `apps/web/components/diff/` |
| Sandbox / Preview | `apps/server/src/sandbox/` |
| 一键部署 | `apps/server/src/deploy/` |
| Plan 可视化编辑 | `apps/web/components/plan/` + `apps/server/src/orchestrator/plan.service.ts` |
| 群聊回放 | `apps/server/src/conversation/replay.service.ts` |
| 匿名预览分享 | `apps/server/src/sandbox/share-link.service.ts` |

## 开发命令

```bash
pnpm dev          # 并行启动 web + server
pnpm build        # 构建全量
pnpm typecheck    # 全量类型检查
pnpm lint
pnpm db:studio    # 打开 Drizzle Studio
```
