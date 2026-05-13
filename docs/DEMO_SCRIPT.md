# 10 分钟演示脚本（PRD §15 实操版）

> Demo 总时长 10 分钟。脚本预演 3 次以上，时间能压到 8 分钟更好（留 buffer）。

## 演示前清单

- [ ] `.env` 已配 `ANTHROPIC_API_KEY` + `OPENAI_API_KEY`（哪怕只配一个也行）
- [ ] `SANDBOX_PROVIDER=mock` 备用（防演示时容器拉起失败）
- [ ] 提前在 `packages/adapter-mock/fixtures/` 录好 fallback 对话
- [ ] 浏览器开 2 个 tab：a) AgentHub b) 部署后的公开 URL（备份）
- [ ] 录屏软件待命（OBS）；网络异常立刻切录屏

## 时间轴

| 时间 | 内容 | 重点话术 |
|------|------|---------|
| 0:00–1:30 | **背景 + 适配器层架构图** | "我们没有重新发明 Agent，而是给现有 Agent 造了一个能协作的房间。" |
| 1:30–3:00 | **单聊 demo**：让 Claude Code 写 "天气卡片" 组件，展示流式 + Diff | "首字 1 秒内出，patch 直接 inline 渲染，hunk 级 accept。" |
| 3:00–6:00 | **群聊 demo**：拉群（架构师 + 前端 + 后端 + DevOps）→ 一句话 "做待办 App" → Plan Card 自动出现 → 多 Agent 并行 → 群内 @ 互相引用 | "Plan Card 不是黑盒，可以**直接拖编辑 DAG** — 别家框架做不到。" |
| 6:00–8:00 | **Workspace + Preview** → 故意 reject 某个 hunk 看回退 | "snapshot 是不可变的，回退零成本。" |
| 8:00–9:30 | **一键部署 + 匿名分享链接** | "评委可以扫码或点链接直接看到运行中的 App，token 24h 过期。" |
| 9:30–10:00 | **切到 Codex Adapter** 重跑同 Prompt | "换 Agent 平台零业务代码改动 — 这就是适配器层的价值。" |

## Plan B（出意外时）

1. **真 Agent 报错**：UI 立即切换到 `mock` adapter（preset 在 settings 里），继续走脚本，事后说明 "为了演示稳定切到了 Mock"。
2. **沙箱拉不起来**：切到提前部署好的公开 URL（备份 tab）。
3. **WS 断了**：演示离线回放（F2.7） — 反而展示了"回放"功能，把劣势转优势。
4. **网络全挂**：切录屏，旁白同步讲解。

## 评委可能问的问题（预演答案）

**Q1：你们和 CrewAI / AutoGen / MetaGPT 的区别？**
A：它们是框架（SDK），我们是产品。框架不解决用户的"看不见输出 / 输出不可控 / 没法部署"的痛点。我们用 IM 隐喻把多 Agent 协作做成可视化、可干预、可交付。

**Q2：适配器层不就是个抽象 wrapper 吗？**
A：表面看是。深一层是：① 统一错误码 + 重试策略；② Capability-aware 调度；③ 中间件链（缓存 / 限流 / Prompt 改写）；④ 文件系统统一走平台 sandbox 代理。让上层完全不感知厂商差异，这才是真正的护城河。

**Q3：Orchestrator 不就是 LangGraph？**
A：LangGraph 是一段代码。我们的 Orchestrator 是**用户可见、可编辑、可回放**的产品形态 — Plan 是一等公民。

**Q4：怎么保证 demo 时不烧光 token？**
A：每会话有 budget 上限，Mock Adapter 兜底，演示用 fixtures 回放。
