# AgentHub — 多 Agent 协作平台 · 产品需求文档（PRD）

> 字节跳动 AI 全栈开发挑战赛参赛课题
> 版本：v1.0（已经历 3 轮内部迭代）
> 最后更新：2026-05-12

---

## 0. 文档说明与迭代记录

| 版本 | 内容 |
|------|------|
| v0.1 | 初稿：骨架 + 基础功能清单 |
| v0.2 | 补强适配器层契约、@ 群聊协议、Orchestrator 算法、Prompt 工程、TRAE 协同定位、沙箱安全、可观测性 |
| v1.0 | 加入 MoSCoW 优先级、验收标准、竞品对比、评分维度对齐、场景示例（含失败路径） |
| v1.1 | 三个未决问题落地：群聊回放（F2.7）、人工编辑 Plan DAG（§5.5.4）、匿名只读预览分享链接（F7.6） |

---

## 1. 项目概述

**AgentHub** 是一个 **IM 聊天式的多 Agent 协作开发平台**。它把当下分散的 Agent 编码工具（Claude Code、Codex、豆包等）通过**统一适配器层**聚合到一个类飞书 / 微信的聊天界面中，让开发者像和同事拉群一样调度多个 Agent 协作完成一个开发任务，并在同一界面内完成**任务拆解 → 代码编辑 → Diff 审阅 → 网页预览 → 一键部署**的全流程。

### 1.1 一句话定位

> "把 Claude Code、Codex 这些 Agent 拉进同一个微信群，让它们听 @、能分工、能交付。"

### 1.2 设计哲学

1. **IM 是最自然的协作隐喻**：人类已经熟悉单聊、群聊、@、引用、撤回，零学习成本。
2. **适配器层是平台的护城河**：底层 Agent 平台百花齐放，**抽象稳定的能力契约**比绑定单一厂商更有价值。
3. **Orchestrator 不是替代人，而是放大人**：人决定目标与边界，Orchestrator 处理拆解与编排。
4. **Diff 与 Preview 让 AI 输出可验证**：所有 Agent 产物都必须能被人快速 review、回退、接受。

---

## 2. 背景与机会

### 2.1 行业趋势

- 单 Agent 已无法满足复杂工程任务，**Multi-Agent 协作**成为提效关键路径（参考 AutoGen、CrewAI、LangGraph、MetaGPT）。
- 主流 IDE / Agent 工具（Claude Code、Codex CLI、Cursor、TRAE、Cline）形态各异，**用户在不同窗口间切换成本高**。
- 团队场景下，开发者更习惯**异步、可追溯、可邀请**的 IM 协作模式，而非单线 REPL。

### 2.2 痛点

| 痛点 | 现状 | AgentHub 解法 |
|------|------|-------------|
| 多工具切换 | Claude Code 在终端、Codex 在 CLI、ChatGPT 在浏览器 | 统一聊天容器 + 适配器层 |
| 单 Agent 偏科 | 前端强的不一定后端强；某些任务要多个模型互补 | 群聊 + @ 调度让多 Agent 互补 |
| 任务拆解靠人脑 | 长任务需要手动 break down 才能丢给 Agent | Orchestrator 自动拆 DAG |
| 输出不可见 | 终端 patch 看不到上下文，Web 应用要本地起服务才能看到效果 | 内嵌 Diff Viewer + 沙箱 Web Preview |
| 部署是断点 | "AI 写完了" 到 "用户能访问" 之间还有运维鸿沟 | 一键部署到 Vercel / Cloudflare / Docker |

### 2.3 与 TRAE 的关系

TRAE 是字节自研的 AI IDE。AgentHub **不与 TRAE 竞争**，而是定位为它的**互补层**：
- **TRAE 解决"我自己 + 1 个 Agent"** 在 IDE 里深度编码的场景；
- **AgentHub 解决"我 + 多个 Agent"** 在 IM 中协作 / 编排 / 评审的场景；
- 两者通过约定的产物格式（Patch / Plan）互通，AgentHub 可把方案推送到 TRAE 中继续精修，TRAE 也可把代码片段反向回灌到 AgentHub 群聊请其他 Agent 评审。

---

## 3. 目标与非目标

### 3.1 目标（O）

1. **O1**：在赛事 demo 周期内，跑通 "建群 → @Agent → 拆解 → 多 Agent 并行 → Diff → Preview → 部署" 的完整闭环。
2. **O2**：适配器层覆盖至少 3 个主流 Agent 后端（Claude Code、Codex、豆包/Doubao 或开源代表），换 Agent 无需改业务代码。
3. **O3**：单用户支持同时维持 ≥ 5 个并行会话不卡顿（首字延迟 P95 < 2s）。
4. **O4**：Orchestrator 在公开评测集（如 SWE-bench Lite 子集 / 内部基准）上端到端任务成功率 ≥ 单 Agent baseline + 15%。

### 3.2 非目标（Not in scope）

- ❌ 多人多端实时协同编辑（共编同一份代码 buffer）— 留给 IDE / TRAE。
- ❌ 自研基础大模型 — 仅做编排和适配。
- ❌ 完整的项目管理（Jira / 看板替代）— 仅做开发任务级编排。
- ❌ 移动端原生 App — 仅 Web（移动端做响应式适配，不做原生）。
- ❌ 企业级 RBAC、SSO、审计合规 — Demo 阶段单用户 / 邀请码模式。

---

## 4. 用户画像与核心场景

### 4.1 用户画像

| 画像 | 描述 | 关注点 |
|------|------|--------|
| **个人独立开发者 Eva** | 用 AI 工具高频造小项目 | 速度、低门槛、能直接看到效果并部署 |
| **小团队技术 Lead Frank** | 带 2-3 人小团队，想把 Agent 接到日常工作流 | 可控、可审计、人工卡点 |
| **AI 工具研究者 Grace** | 想对比多 Agent / 多 Prompt 效果 | 编排灵活性、产物可对照、可复现 |

### 4.2 核心用户故事（User Stories）

- **US-1**：作为 Eva，我想跟一个 "前端 Agent" 单聊，让它给我写一个 Landing Page，写完后能直接预览并部署到一个公开链接。
- **US-2**：作为 Frank，我想拉一个群，里面有 "架构师 Agent"、"前端 Agent"、"后端 Agent"，@架构师 帮我设计方案后自动 @前端 和 @后端 并行写代码。
- **US-3**：作为 Grace，我想就同一个 Prompt，让 Claude Code 和 Codex 各写一版方案，在聊天里看 Diff 对比，挑一个合并。
- **US-4**：作为 Eva，我提了个含糊的需求 "做一个待办清单 App"，希望 Orchestrator 帮我自动拆成 5 个子任务，分派给合适的 Agent，并把进度以"工作流卡片"的形式展示在群里。
- **US-5**：作为 Frank，某个 Agent 走偏了，我能在群里 "撤回" 它的提交、回滚 Diff、不影响其他子任务。

### 4.3 反向场景（要明确不支持或降级的场景）

- 长任务（> 30 分钟）：v1 不支持完全后台离线，需用户保持会话；后续版本接入 Job Queue + 邮件通知。
- 二进制大文件 / 多媒体输入：v1 限制单消息 ≤ 5MB，仅文本 / 代码 / 图片。

---

## 5. 功能需求（MoSCoW 优先级）

> Must = 决赛必须；Should = 提升评分关键；Could = 锦上添花；Won't = 本期不做。

### 5.1 账号与工作空间（Must）

| 编号 | 功能 | 描述 | 验收标准 |
|------|------|------|---------|
| F1.1 | 邮箱 + 邀请码注册 | 简化注册，赛事评审无需复杂账号体系 | 输入邮箱 + 验证码即可登录 |
| F1.2 | API Key 管理 | 用户填入 Claude / OpenAI / 豆包等 Key，加密存储 | Key 仅以摘要展示，可删除 / 轮换 |
| F1.3 | 工作空间隔离 | 每个用户的会话 / 文件 / 部署彼此隔离 | 不同用户互相不可见 |

### 5.2 IM 容器（Must）

| 编号 | 功能 | 描述 | 验收标准 |
|------|------|------|---------|
| F2.1 | 会话列表 | 左侧栏，按最近活跃排序，支持置顶、未读红点 | 单 Agent / 群聊混排，可搜索 |
| F2.2 | 多会话并行 | 切换会话不打断后台 Agent 任务 | 切走时仍流式收消息，回来续上 |
| F2.3 | 消息类型 | text / code / diff / preview-card / plan-card / deploy-card / system | 每类有专属渲染器 |
| F2.4 | 流式输出 | Agent 回复 token 级流式渲染 | 首 token 延迟 P95 < 2s |
| F2.5 | 引用 / 撤回 / 编辑 | 类微信，支持 reply 到具体消息、24h 内撤回 | 引用消息在被引用消息可点击跳转 |
| F2.6 | 消息搜索 | 全文检索会话历史 | 关键字命中高亮，跨会话可搜 |
| F2.7 | 群聊回放 | 把整段群聊 + Plan 变迁 + Diff 时间轴重新播放，可逐步进 / 倍速 | 评审 / 复盘 / 评委演示均高价值；支持导出为可分享链接 |

### 5.3 群聊与 @ 协议（Must）

| 编号 | 功能 | 描述 | 验收标准 |
|------|------|------|---------|
| F3.1 | 建群 | 选择多个 Agent 角色 + 自定义群名 / 群规则 | 群内可见参与者头像列表 |
| F3.2 | @ 指令路由 | `@AgentA` 触发 A 单 Agent 响应；`@all` 广播 | 未被 @ 的 Agent 默认静默 |
| F3.3 | 转发 / 引用触发 | A 的回复中 @B，自动触发 B 并把 A 的回复作为上下文 | 形成 Agent-to-Agent 链路 |
| F3.4 | 群规则（System Prompt） | 群级 system prompt 注入到所有 Agent | 例如 "全员用中文回复，代码遵循 ESLint" |
| F3.5 | 静音 / 踢出 / 邀请 | 群内成员管理 | 踢出后该 Agent 不再被路由 |

**@ 协议详细语义：**

```
用户消息含 @AgentA  →  路由器把消息发给 AgentA，并把当前群上下文（最近 N 条 + 群 system prompt）一起注入
AgentA 回复含 @AgentB →  路由器把 A 的回复转成 user-role 消息发给 B（B 视角下"用户"就是 A）
回复不含 @          →  消息以 assistant role 落到群历史，不触发任何 Agent
@all                →  并行触发所有 Agent，UI 按返回顺序流式展示
```

**冲突解决：** 当多个 Agent 同时被 @，并发执行；如某 Agent 在生成中又被 @，**取消旧任务**（cancellable stream），用新上下文重启。

### 5.4 适配器层 AgentAdapter（Must · 评分核心）

> **此为本项目最重要的技术抽象**。所有上层逻辑（编排、UI、计费）只依赖该接口，不感知具体 Agent 平台。

#### 5.4.1 接口契约（TypeScript 表达）

```ts
interface AgentAdapter {
  readonly id: string;              // "claude-code", "codex", "doubao-pro"
  readonly capabilities: Capabilities;

  chat(req: ChatRequest): AsyncIterable<ChatEvent>;     // 流式
  cancel(taskId: string): Promise<void>;
  estimateCost(req: ChatRequest): CostEstimate;
  health(): Promise<HealthStatus>;
}

interface Capabilities {
  streaming: boolean;
  toolUse: boolean;
  codeExecution: boolean;      // 自带沙箱执行能力
  fileEdit: boolean;           // 直接编辑文件系统
  webBrowse: boolean;
  maxContextTokens: number;
  supportedLangs: string[];    // ["zh", "en"]
}

interface ChatRequest {
  taskId: string;
  systemPrompt?: string;
  messages: Message[];         // OpenAI 风格统一格式
  tools?: ToolSchema[];
  workspace?: WorkspaceRef;    // 当前工作目录 / 文件系统快照
  budget?: { maxTokens: number; maxTimeMs: number };
}

type ChatEvent =
  | { type: "token"; text: string }
  | { type: "tool_call"; name: string; args: any; callId: string }
  | { type: "tool_result"; callId: string; result: any }
  | { type: "file_patch"; path: string; diff: string }
  | { type: "thinking"; text: string }      // 可选思考过程
  | { type: "done"; usage: TokenUsage }
  | { type: "error"; error: { code: string; message: string; retryable: boolean } };
```

#### 5.4.2 适配器实现矩阵

| 适配器 | 接入方式 | 特性 |
|--------|---------|------|
| `ClaudeCodeAdapter` | Claude Code SDK / @anthropic-ai/sdk | 工具调用、文件编辑、长上下文 |
| `CodexAdapter` | OpenAI Responses API + Codex CLI | 强代码补全、agentic loop |
| `DoubaoAdapter` | 火山引擎方舟 SDK | 中文场景优化、低成本 |
| `OpenAIChatAdapter` | OpenAI API | 通用 fallback |
| `MockAdapter` | 本地回放 | E2E 测试 / 演示用，不烧钱 |

#### 5.4.3 设计要点

- **Capability-aware 调度**：Orchestrator 选 Agent 时按能力匹配，而非硬编码。
- **统一错误码**：`RATE_LIMITED / CONTEXT_OVERFLOW / TOOL_UNAVAILABLE / UPSTREAM_5XX`，上层统一重试 / 降级策略。
- **可注入中间件**：日志、缓存、限流、Prompt 改写器均以中间件形式套在 Adapter 外。
- **沙箱代理**：Adapter 若声明 `fileEdit: true`，文件系统操作必须经平台沙箱代理（不直连本机）。

### 5.5 Orchestrator 协调器（Must · 评分核心）

#### 5.5.1 流程

```
用户目标 + 上下文
     ↓
[Planner Agent]  → 输出 Plan（DAG）：节点 = Task，边 = 依赖
     ↓
[Assigner]       → 每个 Task 按 capability + 成本选一个 Agent
     ↓
[Executor]       → 拓扑序并发执行；每个 Task 流式上报状态
     ↓
[Critic]         → 验收单个 Task 输出（编译、测试、规则匹配）
     ↓ 失败时
[Replanner]      → 局部重规划（仅替换失败子图）
     ↓
[Stitcher]       → 把多 Agent 产物合并（代码 patch 合并、文档串联）
     ↓
最终交付（Diff + Preview + Deploy）
```

#### 5.5.2 算法关键点

- **Plan 表示**：JSON DAG（节点含 `id / goal / assignee / inputs / acceptance`）。
- **并发**：同层节点并行；跨层按 topological order；上限可配（默认 max parallel = 3）。
- **失败处理**：单节点失败 → 局部 replan（最多 2 次），仍失败 → 上抛人工卡点（群内 system message 询问用户）。
- **可视化**：群聊里以 **Plan Card** 形式展示当前 DAG，节点点击可看子任务详情 / 子会话。
- **可中断**：用户可随时 "暂停" 整个 Plan，也可单独取消某节点。

#### 5.5.3 示例（US-4 落地）

```
用户输入："做一个待办清单 App"
   ↓
Plan:
  T1 (架构师/Doubao): 需求澄清 + 选型
  T2 (前端/ClaudeCode): React + Vite 脚手架  ← 依赖 T1
  T3 (后端/Codex):     FastAPI + SQLite      ← 依赖 T1
  T4 (前端/ClaudeCode): TodoList UI          ← 依赖 T2
  T5 (后端/Codex):     CRUD API              ← 依赖 T3
  T6 (前端/ClaudeCode): 联调 + 调用 T5 接口   ← 依赖 T4,T5
  T7 (DevOps/任一):    Dockerfile + 一键部署 ← 依赖 T6
```

#### 5.5.4 人工编辑 Plan DAG（Should · 差异化亮点）

主流多 Agent 框架（CrewAI / AutoGen / MetaGPT）的编排基本是**黑盒**：Plan 出来即执行，用户无法干预。AgentHub 将 Plan 作为**一等公民**展示在群聊中，且允许人工直接编辑 DAG：

| 能力 | 描述 |
|------|------|
| 节点级 | 增 / 删 / 重命名节点；改 assignee（换 Agent）；改 acceptance 标准 |
| 边级   | 拖拽建立 / 删除依赖；自动检查环 |
| 提示  | 改完后 Orchestrator 用 dry-run 评估影响，群内 system message 反馈"预计影响 N 个下游节点" |
| 模板  | 编辑后的 Plan 可保存为 "PlanTemplate"，下次同类任务直接套用 |
| 协同  | 编辑时通过乐观锁防止用户与 Replanner 并发写冲突；冲突时让用户手动 resolve |

**为什么这是差异化亮点**：
1. **可控性**：把 Orchestrator 从"黑盒"变"半透明白盒"，让 Frank / Grace 这类有经验用户能 override AI 决策。
2. **可教学**：Plan 可视化 + 可编辑相当于一个"AI 项目拆解教学课"。
3. **可复用**：PlanTemplate 等价于 "AI 工作流"，可在团队 / 社区分享，形成长尾价值。

### 5.6 代码 Diff 与 Workspace（Must）

| 编号 | 功能 | 验收标准 |
|------|------|---------|
| F6.1 | Workspace 文件树 | 每会话 / 群一个虚拟 workspace，文件可浏览 |
| F6.2 | Inline Diff | 消息卡片内 split / unified 切换，语法高亮 |
| F6.3 | Hunk 级 accept / reject | 部分接受 patch；reject 后该 hunk 不入库 |
| F6.4 | 版本快照 | 每次 accept 形成一个 commit-like snapshot，可回滚 |
| F6.5 | 冲突合并 | 多 Agent 同文件并行修改 → 三方合并 UI |

### 5.7 网页预览 Sandbox（Must）

| 编号 | 功能 | 验收标准 |
|------|------|---------|
| F7.1 | 前端项目预览 | 检测到 `package.json` 自动起 dev server，iframe 嵌入聊天 |
| F7.2 | 全屏 / 设备模拟 | 一键全屏，预设手机 / 平板尺寸 |
| F7.3 | 后端 / 全栈预览 | 起容器 + 反代，给出公开 URL（带 token） |
| F7.4 | 日志面板 | stdout / stderr 实时回流到聊天侧栏 |
| F7.5 | 沙箱隔离 | 资源限额、网络白名单、5 分钟空闲自动回收 |
| F7.6 | 匿名只读分享链接 | 生成带签名 token 的临时 URL，可对外展示运行中的预览 | 24h 过期 / 限速 / IP 频控 / 可一键撤销 / 链接默认禁用任何写操作 |

**沙箱实现选项（择一 + 兜底）：**
1. **E2B Sandbox**（首选，云端容器，开箱即用）
2. **WebContainer / StackBlitz**（纯前端，零后端成本，但只支持 Node 项目）
3. **自建 Docker 容器池**（兜底，可控但运维重）

### 5.8 一键部署（Should）

| 目标 | 适配 | 备注 |
|------|------|------|
| Vercel | API token | 前端 / Next.js |
| Cloudflare Pages / Workers | API token | 前端 + Edge |
| Render / Railway | API token | 全栈 |
| 自建 Docker | webhook | 兜底 |

部署成功后聊天里渲染 **Deploy Card**：URL、commit、状态、回滚按钮。

### 5.9 Prompt 工程模块（Should · 评分项）

- **角色库（Role Library）**：内置 "架构师 / 前端 / 后端 / DevOps / 评审" 等 system prompt 模板，用户可 fork、版本化。
- **Prompt 变量**：`{{workspace.tree}} {{user.style}} {{group.rules}}` 等动态注入。
- **Prompt Diff & A/B**：同一任务用不同 Prompt 跑两次，输出并排对比。
- **Few-shot 注入**：每个角色可挂示例对话，提升一致性。
- **思考链可视化**：开启 thinking 模式时，把推理过程折叠展示，不污染主对话流。

### 5.10 可观测性与审计（Should）

- 每个 Agent call 记录：模型 / 时延 / token / 成本 / 工具调用链
- 群聊视图叠加 "调试模式"：显示路由决策、Orchestrator 计划变更、重试次数
- 导出会话为 Markdown / JSON（用于赛事提交、复现）

### 5.11 计费与配额（Could）

- 用户级日度 token 上限
- 每次任务预算（max tokens / max time）由 Orchestrator 拆给子任务

### 5.12 不在本期范围（Won't）

- 多人多端同 workspace 实时协作
- 企业级 SSO / RBAC
- 自定义 Agent 训练 / fine-tune

---

## 6. 系统架构

### 6.1 总体架构图（文字版）

```
┌─────────────────────────── Browser (Next.js 15) ───────────────────────────┐
│  IM UI · Diff Viewer · Sandbox iframe · Plan Card · Deploy Card           │
└──────────────────────────────────│─────────────────────────────────────────┘
                                   │  WebSocket (events) + HTTPS (CRUD)
┌──────────────────────────────────▼─────────────────────────────────────────┐
│                   Gateway / BFF (Next.js Route Handlers + tRPC)            │
│  Auth · Session · Stream Multiplexer · Rate Limit                          │
└──────────────────────────────────│─────────────────────────────────────────┘
                                   │
┌──────────────────────┬───────────┴────────────┬──────────────────────────┐
│  Conversation Svc    │  Orchestrator Svc      │  Workspace Svc           │
│  (NestJS)            │  (NestJS + LangGraph)  │  (NestJS)                │
│  - 消息存储          │  - Planner / Assigner  │  - 文件树 / 快照 / Diff   │
│  - 群规则 / @ 路由   │  - Executor / Critic   │  - Snapshot store        │
└──────────┬───────────┴───────────┬────────────┴───────────┬──────────────┘
           │                       │                        │
           │                       ▼                        ▼
           │              ┌──────────────────┐    ┌───────────────────┐
           │              │ AgentAdapter     │    │ Sandbox Svc       │
           │              │   ├─ Claude Code │    │  ├─ E2B           │
           │              │   ├─ Codex       │    │  ├─ Docker pool   │
           │              │   ├─ Doubao      │    │  └─ WebContainer  │
           │              │   └─ Mock        │    └───────────────────┘
           │              └──────────────────┘
           ▼
┌────────────────────────────────────────────────────────────────────────────┐
│  Infra: PostgreSQL · Redis (pub/sub + BullMQ) · MinIO/S3 · OpenTelemetry   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 6.2 关键技术决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 前端框架 | Next.js 15 + React 19 + TS | App Router + RSC，SSR 利于演示首屏；生态最广 |
| UI 库 | Tailwind + shadcn/ui | 风格统一、可改、零运行时 |
| 状态管理 | Zustand + TanStack Query | 轻量、流式数据友好 |
| Diff 渲染 | Monaco Diff Editor | 与 VS Code 同源，体验天花板 |
| 实时通信 | WebSocket（fallback SSE） | 双向、低延迟 |
| 后端 | NestJS（TS 全栈一致）/ 或 FastAPI | TS 全栈减少切换成本；如有 Python 团队成员可换 |
| Orchestrator | LangGraph（开源）或自研 | LangGraph 自带 DAG / checkpoint；自研给评委看深度 |
| 沙箱 | E2B 为主，Docker 兜底 | E2B 开箱即用，演示稳；Docker 给评委看 infra 能力 |
| 数据库 | PostgreSQL + Drizzle ORM | 关系 + JSONB 灵活；Drizzle 类型安全 |
| 缓存 / 队列 | Redis + BullMQ | 任务编排、流广播 |
| 部署 | Vercel（前端）+ Fly.io / Railway（后端）+ Cloudflare R2 | 演示便利 |
| Observability | OpenTelemetry + Langfuse | 大模型链路追踪事实标准 |

### 6.3 数据流：典型用户请求

1. 用户在群聊 @ArchitectAgent 发问。
2. 前端 WebSocket → Gateway → Conversation Svc 入库 + Orchestrator Svc。
3. Orchestrator 命中 @ 单 Agent 路径 → 经 AgentAdapter 调用 Claude Code。
4. Adapter 返回 `AsyncIterable<ChatEvent>` → Gateway 通过 WebSocket frame 推前端。
5. Adapter 中流式产生 `file_patch` 事件 → Workspace Svc 立即落盘到 snapshot。
6. Patch 完成后 Conversation Svc 生成 Diff Card 推回前端。
7. 用户点击 "预览"，Sandbox Svc 起容器 → 返回 URL → iframe 嵌入。
8. 用户点击 "部署"，Deploy 流程触发，状态卡片实时刷新。

### 6.4 并发与一致性

- 单会话内消息有序：Conversation Svc 用 Redis stream 保序。
- 跨会话并发：每个会话独立 worker（BullMQ），用户切走不阻塞。
- Workspace 写入：每次 patch 都建 snapshot（不可变），accept = 移动 HEAD 指针，CAS 防竞态。

---

## 7. 数据模型（核心表）

```sql
users(id, email, created_at)
api_keys(id, user_id, provider, secret_encrypted, created_at)
agents(id, name, adapter_type, system_prompt, owner_user_id, is_public)
conversations(id, type[single|group], owner_user_id, title, created_at)
conversation_members(conversation_id, agent_id, role[admin|member|muted])
messages(id, conversation_id, sender_type[user|agent|system], sender_id,
         content_type, body_jsonb, reply_to_id, created_at, deleted_at)
workspaces(id, conversation_id, head_snapshot_id)
snapshots(id, workspace_id, parent_id, files_blob_ref, message_id, created_at)
plans(id, conversation_id, root_task_id, status, dag_jsonb)
tasks(id, plan_id, parent_id, goal, assignee_agent_id, status,
      acceptance_jsonb, retries, created_at, finished_at)
agent_calls(id, task_id, adapter, model, prompt_tokens, completion_tokens,
            cost_usd, latency_ms, status, error_code, span_id)
deployments(id, conversation_id, target, url, snapshot_id, status, log_ref)
sandboxes(id, conversation_id, provider, url, expires_at, status)
```

---

## 8. 关键接口与协议

### 8.1 WebSocket 事件协议

```ts
// client → server
{ "op": "user_msg", "conversationId": "...", "content": {...}, "mentions": ["agent_xx"] }
{ "op": "cancel", "taskId": "..." }
{ "op": "accept_patch", "snapshotId": "...", "hunkIds": [...] }

// server → client
{ "op": "msg_token", "msgId": "...", "delta": "..." }
{ "op": "msg_done", "msgId": "...", "usage": {...} }
{ "op": "plan_update", "planId": "...", "dag": {...} }
{ "op": "patch", "msgId": "...", "files": [...] }
{ "op": "preview_ready", "url": "..." }
{ "op": "deploy_status", "deploymentId": "...", "status": "..." }
{ "op": "error", "code": "...", "message": "...", "retryable": true }
```

### 8.2 REST API（关键）

- `POST /api/conversations` 建会话 / 群
- `GET /api/conversations/:id/messages?cursor=` 分页拉取
- `POST /api/snapshots/:id/accept` 接收 patch
- `POST /api/sandbox/start` 启动预览
- `POST /api/deploy` 触发部署
- `GET /api/agents` 列出可用 Agent
- `GET /api/observability/trace/:taskId` 调试视图

---

## 9. UI / UX 设计要点

### 9.1 布局

```
┌──────────────┬──────────────────────────────────┬─────────────────┐
│  Sidebar     │  Chat Pane                       │  Right Panel    │
│  - 会话列表  │  - 消息流                        │  - Workspace    │
│  - 新建按钮  │  - 输入框（支持 @ 自动补全）     │    / Plan       │
│  - 搜索      │                                  │    / Preview    │
│              │                                  │    / Deploy     │
└──────────────┴──────────────────────────────────┴─────────────────┘
```

### 9.2 交互细节

- @ 触发：输入 `@` 弹出参与者面板（图标 + 能力标签）；上下键选择，Tab / 回车确认。
- 长 Agent 消息：超过 8 屏自动折叠，"展开全部 / 复制 / 引用"。
- Plan Card：节点支持点击 → 钻取到对应子会话；节点状态实时变色。
- Diff Card：默认 unified，可切 split；点击行号 → 评论（v2）。
- Preview / Workspace 联动：在 Workspace 双击文件 → Diff 高亮跳转。
- 键盘：`Ctrl/Cmd+K` 全局命令面板（切会话 / 触发部署 / 取消任务）。

### 9.3 视觉

- 主色：参考类似飞书的克制蓝灰 + Agent 头像彩色边框区分。
- 暗色模式必备。
- Agent 头像：每个 Agent 一个独特配色 + 字母 monogram；用户头像与 Agent 头像形状不同（防混淆）。

---

## 10. 性能与质量

| 指标 | 目标 |
|------|------|
| 首字延迟 P50 / P95 | < 1s / < 2s |
| WebSocket 消息 RTT | < 100ms（本地） |
| 5 并行会话内存占用 | < 500MB（浏览器） |
| 服务端单实例并发会话 | ≥ 100 |
| 任务端到端成功率 | ≥ 90%（demo 集） |
| 错误回退率 | 自动重试可解决率 ≥ 80% |

---

## 11. 安全与隐私

- API Key 用 AES-GCM 落库，envelope encryption（KMS / 本地 sealed box）。
- 沙箱：网络白名单、CPU / 内存限额、文件系统只读除 /workspace、5 分钟空闲回收。
- 用户代码不进入训练 / 不跨用户共享。
- 部署 token 最小权限原则。
- 敏感日志脱敏（key / token 自动 mask）。

---

## 12. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|------|------|------|
| Claude Code / Codex API 不稳定 | 中 | 高 | Adapter 中实现重试 / 降级到 Mock；预录演示视频备份 |
| 多 Agent 长链路上下文爆炸 | 高 | 高 | Orchestrator 子任务独立上下文 + 摘要回传；Stitcher 只看 acceptance 结果 |
| 沙箱演示失败（网络 / 容器） | 中 | 高 | 双沙箱（E2B + WebContainer）+ 本地兜底 |
| @ 群聊死循环 / 互 @ | 中 | 中 | 全局 hop 计数上限（默认 6 跳）+ Orchestrator 检测圈 |
| Demo 时 token 烧光 | 中 | 高 | 配额 + Mock 模式 + 离线回放 fixtures |
| 评委关注创新点不足 | — | 高 | 突出适配器层 + Orchestrator + IM 隐喻三件套 |

---

## 13. 里程碑（建议 6 周节奏，按赛事时间调整）

| Sprint | 周 | 交付 |
|--------|----|------|
| S0 | W1 | 仓库初始化、技术栈打通、Mock Adapter 跑通 hello world、UI 骨架 |
| S1 | W2 | 单聊 + 流式 + 一个真 Adapter（Claude Code 或 Doubao） |
| S2 | W3 | 群聊 + @ 路由 + 第二个 Adapter；Workspace + Diff 基础 |
| S3 | W4 | Orchestrator MVP（线性 plan）+ Plan Card；E2B 预览 |
| S4 | W5 | Orchestrator DAG + Critic + Replanner；一键部署 (Vercel) |
| S5 | W6 | Prompt 模块、可观测性、演示 demo 录制、文档与提交材料 |

每 Sprint 末做一次 demo + 风险评估。

---

## 14. 验收与评分维度对齐

赛题评分通常含：功能完整度、用户体验、技术深度、创新、工程质量、演示效果。AgentHub 设计上对应如下加分点：

| 评分维度 | AgentHub 亮点 |
|---------|-------------|
| 功能完整度 | 单聊 / 群聊 / @ / Orchestrator / Diff / Preview / Deploy 全闭环 |
| 用户体验 | IM 隐喻 + 流式 + 撤回 / 引用 / 搜索 + 命令面板 |
| 技术深度 | AgentAdapter 抽象 + 多平台真接 + Orchestrator DAG + Critic 重规划 |
| 创新 | Agent-to-Agent 通过 @ 形成群聊链 + Plan Card 可视化 + 与 TRAE 协同 |
| 工程质量 | Snapshot 不可变模型 + 中间件式扩展 + OpenTelemetry 全链路追踪 |
| 演示效果 | 一句话 → 群聊 → 多 Agent 并行 → Preview → 公开 URL 部署（< 10 分钟） |

---

## 15. 演示脚本（Demo 备份）

> 10 分钟黄金演示路径：

1. **0:00–1:30** 介绍背景与适配器层设计（PPT 一页）。
2. **1:30–3:00** 单聊：让 Claude Code 写一个 "天气卡片" 组件，展示流式 + Diff。
3. **3:00–6:00** 拉群（架构师 / 前端 / 后端）→ 一句话需求 "做待办 App" → Plan Card 出现 → 多 Agent 并行 → 群内 @ 互相引用。
4. **6:00–8:00** Workspace 浏览 → Preview 起沙箱看效果 → 故意 reject 某个 hunk 看回退。
5. **8:00–9:30** 一键部署到 Vercel，给评委公开 URL。
6. **9:30–10:00** 切到 Codex Adapter 重跑同 Prompt，展示适配器层威力。

---

## 16. 附录

### 16.1 竞品速览

| 工具 | 形态 | 与 AgentHub 差异 |
|------|------|----------------|
| Claude Code / Codex CLI | 终端单 Agent | 不支持多 Agent / IM / 群聊 |
| Cursor / TRAE | IDE 内 Agent | 编码深度强，协作 / 编排弱 |
| CrewAI / AutoGen | 框架 / 库 | 是 SDK 不是产品，缺 UI / IM |
| MetaGPT | 多 Agent SOP | 流程固化，无 IM 自由对话 |
| Devin | 远端单 Agent | 黑盒，无群聊隐喻 |

### 16.2 术语表

- **Adapter**：把异构 Agent 平台统一到 `AgentAdapter` 接口的组件。
- **Plan / DAG**：Orchestrator 产生的任务依赖图。
- **Snapshot**：Workspace 的不可变版本，类似 git commit。
- **Hop**：群聊中 Agent-to-Agent 互相 @ 形成的跳数。
- **Critic**：Plan 中负责验收子任务输出的内建组件。

### 16.3 已决问题（Resolved · v1.0）

| 原问题 | 决议 | 落地章节 |
|--------|------|---------|
| 是否提供"群聊回放"功能？ | **加入**（评审 / 复盘 / 评委演示均高价值） | §5.2 F2.7 |
| Plan 是否允许人工编辑 DAG？ | **加入**（差异化亮点，市面多 Agent 框架普遍黑盒） | §5.5.4 |
| 沙箱是否给评委提供"匿名只读"分享链接？ | **加入**（带签名 token / 24h 过期 / IP 频控 / 一键撤销） | §5.7 F7.6 |
