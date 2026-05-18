'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, Loader2, MessageSquare, Sparkles, Users, X } from 'lucide-react';
import clsx from 'clsx';
import { isConversationScopedAgentId, isHiddenSystemAgentId, useConversationStore } from '@/lib/store';
import { prettifyApiError } from '@/lib/api-errors';
import { AgentAvatar } from '../AgentAvatar';

const DEFAULT_GROUP_RULES = `- 全员使用中文回复，结论先行，避免空话。
- 架构师负责拆解和排期，不由系统 Orchestrator 代替规划。
- 涉及代码时必须写入 workspace；修改已有文件优先使用 diff。
- 实现任务必须给出验证方式；能运行命令时优先用 terminal 验证。
- 每个成员只输出自己身份负责的部分，不冒充其他成员。
- 不使用 emoji，不写“我将/首先/接下来/总结/如需请告知”这类模板话。
- 不要把工具调用过程复述进正文；正文只写交付结果、关键文件、验证结果和阻塞。
- 信息不足但不阻断时先基于项目名称、附件和 workspace 文件做合理假设并推进。
- 关键选择会影响产品形态、数据来源、合规边界、部署成本或外部凭据时，先向用户提出具体问题/选项。
- 共享决策、环境变量、Docker 服务、接口契约和交接写入 TEAM_MEMORY.md。
- 禁止占位式交付：前端控件、图表、表格和后端能力必须有真实本地状态/数据流或明确配置说明。`;

const MODEL_OPTIONS = [
  {
    id: 'deepseek-v4-flash',
    label: 'V4 Flash',
    detail: '快 / 便宜 / 日常分析',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'V4 Pro',
    detail: '强推理 / 架构 / 风险',
    adapterId: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
  },
  {
    id: 'codex',
    label: 'Codex',
    detail: '代码实现 / 文件编辑',
    adapterId: 'codex',
    model: 'gpt-4o',
  },
] as const;

type ModelId = (typeof MODEL_OPTIONS)[number]['id'];

const SKILL_LIBRARY = [
  {
    id: 'requirements',
    label: '需求澄清',
    prompt: '先把目标、用户、边界、非目标和验收标准澄清，再进入实现。',
  },
  {
    id: 'task-dag',
    label: '任务 DAG',
    prompt: '把复杂项目拆成可验证的有向任务；每个任务必须有输入、产物、验收方式和依赖关系。',
  },
  {
    id: 'workspace-first',
    label: 'Workspace 优先',
    prompt: '涉及代码或文档时优先读写 workspace 文件，不只在聊天里贴代码。',
  },
  {
    id: 'terminal-verify',
    label: '终端验证',
    prompt: '完成实现后必须说明并尽量执行验证命令，失败时基于真实报错继续修复。',
  },
  {
    id: 'env-docker',
    label: 'Docker/配置',
    prompt:
      '需要数据库、缓存、队列、搜索或外部服务时，创建 .env.example、docker-compose.yml、schema/seed 或等价配置，并用可退出命令验证；Docker 不可用时报告真实错误和修复步骤。',
  },
  {
    id: 'shared-memory',
    label: '共享记忆',
    prompt:
      '把跨角色共享的产品/架构/接口/环境/阻塞/交接结论写入 TEAM_MEMORY.md，其他成员开始前先读它。',
  },
  {
    id: 'no-placeholders',
    label: '无占位交付',
    prompt:
      '禁止假图表、假 KPI、空卡片和只占位的按钮；每个可见控件都要连接真实本地状态、数据流、错误态或明确 disabled 的配置说明。',
  },
  {
    id: 'ui-polish',
    label: '界面打磨',
    prompt:
      '按成熟产品标准做设计，不是 demo：①建立设计系统——4/8 倍数间距、统一圆角与阴影层级、语义色板（主色/中性灰阶/成功/警告/危险）；②排版有层次——标题/正文/辅助文字字号字重拉开、行高约 1.5；③真实状态——空状态有引导、加载有 skeleton、错误有可读提示、hover/active/focus 都有反馈；④布局用卡片/分区/留白组织，关键操作显眼，移动端不破版；⑤过渡 150-250ms、对比度与键盘可达；⑥严禁 AI 味——不要满屏蓝紫渐变、不要默认 MD3 大圆角、不要 emoji。',
  },
  {
    id: 'design-system',
    label: '设计体系',
    prompt:
      '产出前先定一份轻量设计规范（色板/字阶/间距/组件态），并贯穿所有页面保持一致；参考成熟 SaaS（Linear/Notion/Vercel 风格）的克制与精致，而不是模板感。',
  },
  {
    id: 'api-contract',
    label: '接口契约',
    prompt: '先定义接口、数据结构、错误格式和状态流，再写前后端联调逻辑。',
  },
  {
    id: 'risk-scan',
    label: '风险审视',
    prompt: '主动找安全、隐私、越权、部署、成本、不可行假设和边界条件风险。',
  },
  {
    id: 'user-acceptance',
    label: '用户验收',
    prompt: '以真实用户视角检查流程是否顺手、文案是否明确、产物是否解决原问题。',
  },
] as const;

type SkillId = (typeof SKILL_LIBRARY)[number]['id'];

const ROLE_SLOTS = [
  {
    id: 'team-lead',
    badge: 'TL',
    name: '组长',
    summary: '调度大脑：判断派活 / 拆 Plan',
    defaultModel: 'codex' as ModelId,
    defaultSkills: [] as SkillId[],
  },
  {
    id: 'product-analyst',
    badge: 'PM',
    name: '产品分析师',
    summary: '目标、用户、范围、验收',
    // Codex (vision) — needs to read uploaded reference screenshots.
    defaultModel: 'codex' as ModelId,
    defaultSkills: ['requirements', 'shared-memory', 'user-acceptance'] as SkillId[],
  },
  {
    id: 'solution-architect',
    badge: 'AR',
    name: '架构师',
    summary: '架构、模块、任务 DAG',
    // Codex (gpt-4o) is vision-capable — the architect must be able to read
    // screenshots the user uploads when describing the project.
    defaultModel: 'codex' as ModelId,
    defaultSkills: ['task-dag', 'api-contract', 'shared-memory', 'risk-scan'] as SkillId[],
  },
  {
    id: 'frontend-engineer',
    badge: 'FE',
    name: '前端工程师',
    summary: '页面、交互、预览产物',
    defaultModel: 'deepseek-v4-flash' as ModelId,
    defaultSkills: ['workspace-first', 'ui-polish', 'design-system', 'no-placeholders', 'terminal-verify'] as SkillId[],
  },
  {
    id: 'backend-engineer',
    badge: 'BE',
    name: '后端工程师',
    summary: 'API、数据、服务逻辑',
    defaultModel: 'deepseek-v4-flash' as ModelId,
    defaultSkills: ['workspace-first', 'api-contract', 'env-docker', 'shared-memory', 'terminal-verify'] as SkillId[],
  },
  {
    id: 'code-reviewer',
    badge: 'CR',
    name: 'Code Reviewer',
    summary: '代码审查、回归风险',
    defaultModel: 'deepseek-v4-pro' as ModelId,
    defaultSkills: ['risk-scan', 'terminal-verify'] as SkillId[],
  },
  {
    id: 'env-engineer',
    badge: 'EV',
    name: '环境配置员',
    summary: '依赖、脚本、部署前检查',
    defaultModel: 'deepseek-v4-flash' as ModelId,
    defaultSkills: ['workspace-first', 'env-docker', 'shared-memory', 'terminal-verify'] as SkillId[],
  },
  {
    id: 'qa-tester',
    badge: 'QA',
    name: '测试员',
    summary: '测试计划、真实错误复现',
    defaultModel: 'deepseek-v4-flash' as ModelId,
    defaultSkills: ['terminal-verify', 'user-acceptance'] as SkillId[],
  },
  {
    id: 'senior-user',
    badge: 'UX',
    name: '资深用户',
    summary: '体验评估、真实使用反馈',
    defaultModel: 'deepseek-v4-flash' as ModelId,
    defaultSkills: ['user-acceptance', 'ui-polish'] as SkillId[],
  },
  {
    id: 'risk-critic',
    badge: 'RK',
    name: '风险审视员',
    summary: '边界、误用、安全、不可行假设',
    defaultModel: 'deepseek-v4-pro' as ModelId,
    defaultSkills: ['risk-scan', 'task-dag'] as SkillId[],
  },
] as const;

type RoleId = (typeof ROLE_SLOTS)[number]['id'];

const TEAM_BLUEPRINTS = [
  {
    id: 'full-squad',
    name: '完整交付',
    summary: '产品、架构、实现、验证全链路',
    roleIds: [
      'team-lead',
      'product-analyst',
      'solution-architect',
      'frontend-engineer',
      'backend-engineer',
      'code-reviewer',
      'env-engineer',
      'qa-tester',
      'senior-user',
      'risk-critic',
    ],
    ruleNote: '适合端到端项目；先拆任务，再按角色并行推进，最后由 QA 与风险角色收口。',
  },
  {
    id: 'lean-build',
    name: '快速实现',
    summary: '少角色推进，可写代码可验证',
    roleIds: ['team-lead', 'solution-architect', 'frontend-engineer', 'backend-engineer', 'qa-tester', 'code-reviewer'],
    ruleNote: '适合已有方向的实现任务；减少讨论，把规划、实现、验证压进同一轮推进。',
  },
  {
    id: 'frontend-polish',
    name: '体验打磨',
    summary: '界面、交互、验收和风险',
    roleIds: ['team-lead', 'product-analyst', 'frontend-engineer', 'senior-user', 'qa-tester', 'risk-critic'],
    ruleNote: '适合 UI/UX 改造；优先产出可感知的界面变化，并用真实使用路径验收。',
  },
  {
    id: 'audit-hardening',
    name: '审查加固',
    summary: '代码审查、测试、部署风险',
    roleIds: ['team-lead', 'code-reviewer', 'risk-critic', 'qa-tester', 'env-engineer', 'backend-engineer', 'solution-architect'],
    ruleNote: '适合上线前检查；先找会失败的地方，再给出最小修复和验证命令。',
  },
  {
    id: 'research-plan',
    name: '调研规划',
    summary: '先澄清方向，再形成任务图',
    roleIds: ['team-lead', 'product-analyst', 'solution-architect', 'senior-user', 'risk-critic'],
    ruleNote: '适合不确定需求；输出清晰边界、方案取舍、任务 DAG 和下一步落地计划。',
  },
] as const satisfies readonly {
  id: string;
  name: string;
  summary: string;
  roleIds: readonly RoleId[];
  ruleNote: string;
}[];

type TeamBlueprint = (typeof TEAM_BLUEPRINTS)[number];
type BlueprintId = TeamBlueprint['id'] | 'custom';

const buildBlueprintRules = (blueprint: TeamBlueprint) =>
  `${DEFAULT_GROUP_RULES}\n- 团队蓝图：${blueprint.name}。${blueprint.ruleNote}`;

type RoleConfig = {
  selected: boolean;
  modelId: ModelId;
  skillIds: SkillId[];
  customSkills: string;
};

const initialRoleConfigs = (selectedRoleIds?: readonly RoleId[]): Record<RoleId, RoleConfig> => {
  const selected = new Set<RoleId>(selectedRoleIds ?? ROLE_SLOTS.map((role) => role.id));
  return Object.fromEntries(
    ROLE_SLOTS.map((role) => [
      role.id,
      {
        selected: selected.has(role.id),
        modelId: role.defaultModel,
        skillIds: [...role.defaultSkills],
        customSkills: '',
      },
    ]),
  ) as Record<RoleId, RoleConfig>;
};

export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const agents = useConversationStore((s) => s.agents);
  const createConversation = useConversationStore((s) => s.createConversation);

  const [type, setType] = useState<'single' | 'group'>('group');
  const [title, setTitle] = useState('');
  const [singleSelected, setSingleSelected] = useState<Set<string>>(new Set());
  const [roleConfigs, setRoleConfigs] = useState<Record<RoleId, RoleConfig>>(() =>
    initialRoleConfigs(TEAM_BLUEPRINTS[0].roleIds),
  );
  const [activeRoleId, setActiveRoleId] = useState<RoleId>('solution-architect');
  const [activeBlueprintId, setActiveBlueprintId] = useState<BlueprintId>(TEAM_BLUEPRINTS[0].id);
  const [groupRules, setGroupRules] = useState(() => buildBlueprintRules(TEAM_BLUEPRINTS[0]));
  const [busy, setBusy] = useState(false);
  // Synchronous guard: React's setBusy is async, so a fast double-click /
  // Enter+click could both pass the !busy check and create the group twice.
  const submittingRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);

  const availableRoleIds = useMemo(
    () => new Set(ROLE_SLOTS.filter((role) => agents.some((a) => a.id === role.id)).map((role) => role.id)),
    [agents],
  );
  const selectedRoleIds = useMemo(
    () => ROLE_SLOTS.filter((role) => roleConfigs[role.id].selected && availableRoleIds.has(role.id)).map((role) => role.id),
    [availableRoleIds, roleConfigs],
  );
  const singleAgents = useMemo(
    () =>
      agents
        .filter((a) => !isHiddenSystemAgentId(a.id) && !isConversationScopedAgentId(a.id))
        .sort((a, b) => {
          if (a.isPublic !== b.isPublic) return a.isPublic ? -1 : 1;
          return a.name.localeCompare(b.name);
        }),
    [agents],
  );

  const activeRole = ROLE_SLOTS.find((role) => role.id === activeRoleId) ?? ROLE_SLOTS[0];
  const activeConfig = roleConfigs[activeRole.id];
  const canSubmit =
    title.trim().length > 0 &&
    !busy &&
    (type === 'group' ? selectedRoleIds.length > 0 : singleSelected.size === 1);

  const setRoleConfig = (roleId: RoleId, patch: Partial<RoleConfig>) => {
    setActiveBlueprintId('custom');
    setRoleConfigs((prev) => ({
      ...prev,
      [roleId]: { ...prev[roleId], ...patch },
    }));
  };

  const applyBlueprint = (blueprint: TeamBlueprint) => {
    setActiveBlueprintId(blueprint.id);
    setRoleConfigs(initialRoleConfigs(blueprint.roleIds));
    setGroupRules(buildBlueprintRules(blueprint));
    setActiveRoleId(
      blueprint.roleIds.find((roleId) => availableRoleIds.has(roleId)) ?? blueprint.roleIds[0] ?? 'solution-architect',
    );
  };

  const toggleRole = (roleId: RoleId) => {
    setActiveRoleId(roleId);
    if (!availableRoleIds.has(roleId)) return;
    setRoleConfig(roleId, { selected: !roleConfigs[roleId].selected });
  };

  const toggleSkill = (skillId: SkillId) => {
    const skillIds = activeConfig.skillIds.includes(skillId)
      ? activeConfig.skillIds.filter((id) => id !== skillId)
      : [...activeConfig.skillIds, skillId];
    setRoleConfig(activeRole.id, { skillIds });
  };

  const selectStandardTeam = () => {
    applyBlueprint(TEAM_BLUEPRINTS[0]);
  };

  const selectSingleAgent = (id: string) => {
    setSingleSelected(new Set([id]));
  };

  const onSubmit = async () => {
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await createConversation({
        type,
        title: title.trim(),
        memberAgentIds: type === 'single' ? [...singleSelected] : [],
        memberConfigs:
          type === 'group'
            ? selectedRoleIds.map((roleId) => {
                const cfg = roleConfigs[roleId];
                const model = MODEL_OPTIONS.find((item) => item.id === cfg.modelId) ?? MODEL_OPTIONS[0];
                return {
                  roleAgentId: roleId,
                  adapterId: model.adapterId,
                  model: model.model,
                  skills: cfg.skillIds
                    .map((id) => SKILL_LIBRARY.find((skill) => skill.id === id))
                    .filter((skill): skill is (typeof SKILL_LIBRARY)[number] => Boolean(skill))
                    .map((skill) => ({ id: skill.id, label: skill.label, prompt: skill.prompt })),
                  customSkills: cfg.customSkills.trim() ? cfg.customSkills.trim() : null,
                };
              })
            : undefined,
        groupSystemPrompt: type === 'group' && groupRules.trim() ? groupRules.trim() : null,
      });
      onClose();
    } catch (e) {
      setErr(prettifyApiError(e instanceof Error ? e : String(e), '创建失败'));
    } finally {
      setBusy(false);
      submittingRef.current = false;
    }
  };

  return (
    <ModalShell onClose={onClose} title="新建会话" width="w-[780px]">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <TypeBtn
            active={type === 'group'}
            onClick={() => setType('group')}
            icon={<Users className="h-4 w-4" />}
            label="项目群"
            hint="选身份，再给每个身份配置模型和 Skills"
          />
          <TypeBtn
            active={type === 'single'}
            onClick={() => setType('single')}
            icon={<MessageSquare className="h-4 w-4" />}
            label="单聊"
            hint="直接和一个现有 Agent 对话"
          />
        </div>

        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-text-muted">名称</span>
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={type === 'group' ? '例如：小游戏官网增长项目' : '例如：我 + Codex'}
            className="mt-1 w-full rounded-md border border-white/10 bg-bg/70 px-3 py-2 text-sm outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
          />
        </label>

        {type === 'group' ? (
          <div className="space-y-3">
            <section className="rounded-lg border border-white/10 bg-bg/35">
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold text-text">团队蓝图</div>
                  <div className="text-[10px] text-text-muted">先选工作模式，再微调角色、模型和 Skills</div>
                </div>
                {activeBlueprintId === 'custom' ? (
                  <span className="rounded bg-bg-soft px-2 py-1 text-[10px] text-text-muted">已自定义</span>
                ) : null}
              </div>
              <div className="grid gap-1.5 p-2 sm:grid-cols-2 lg:grid-cols-5">
                {TEAM_BLUEPRINTS.map((blueprint) => {
                  const active = activeBlueprintId === blueprint.id;
                  return (
                    <button
                      key={blueprint.id}
                      type="button"
                      onClick={() => applyBlueprint(blueprint)}
                      title={blueprint.ruleNote}
                      className={clsx(
                        'min-h-[76px] rounded-md border px-2.5 py-2 text-left transition',
                        active
                          ? 'border-accent/45 bg-accent/10 text-text'
                          : 'border-white/5 bg-bg/60 text-text-muted hover:border-white/15 hover:text-text',
                      )}
                    >
                      <span className="block truncate text-xs font-semibold">{blueprint.name}</span>
                      <span className="mt-1 block text-[10px] leading-snug text-text-muted">{blueprint.summary}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <div className="grid gap-3 lg:grid-cols-[1fr_1.08fr]">
            <section className="rounded-lg border border-white/10 bg-bg/35">
              <div className="flex items-center justify-between border-b border-white/5 px-3 py-2">
                <div>
                  <div className="text-xs font-semibold text-text">身份席位</div>
                  <div className="text-[10px] text-text-muted">已选 {selectedRoleIds.length} / {ROLE_SLOTS.length}</div>
                </div>
                <button
                  type="button"
                  onClick={selectStandardTeam}
                  className="rounded px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
                >
                  恢复标准团队
                </button>
              </div>
              <div className="max-h-[360px] space-y-1 overflow-y-auto p-2">
                {ROLE_SLOTS.map((role) => {
                  const cfg = roleConfigs[role.id];
                  const model = MODEL_OPTIONS.find((m) => m.id === cfg.modelId);
                  const unavailable = !availableRoleIds.has(role.id);
                  return (
                    <div
                      key={role.id}
                      className={clsx(
                        'flex w-full items-center gap-2 rounded-md border px-2 py-2 transition',
                        activeRoleId === role.id ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-bg-soft/80',
                        cfg.selected && !unavailable ? 'text-text' : 'text-text-muted',
                        unavailable && 'opacity-40',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleRole(role.id)}
                        disabled={unavailable}
                        className={clsx(
                          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[10px] font-bold',
                          cfg.selected && !unavailable ? 'bg-accent text-white' : 'bg-bg-soft text-text-muted',
                        )}
                        title={cfg.selected ? '移出团队' : '加入团队'}
                      >
                        {cfg.selected && !unavailable ? <Check className="h-3.5 w-3.5" /> : role.badge}
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveRoleId(role.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{role.name}</span>
                          <span className="rounded bg-bg-soft px-1.5 py-0.5 text-[9px] text-text-muted">
                            {model?.label}
                          </span>
                        </span>
                        <span className="block truncate text-[10px] text-text-muted">{role.summary}</span>
                      </button>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-lg border border-white/10 bg-bg/35">
              <div className="border-b border-white/5 px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-accent/10 px-2 py-1 text-[10px] font-semibold text-accent">
                    {activeRole.badge}
                  </span>
                  <div>
                    <div className="text-xs font-semibold text-text">{activeRole.name}</div>
                    <div className="text-[10px] text-text-muted">{activeRole.summary}</div>
                  </div>
                </div>
              </div>

              <div className="space-y-4 p-3">
                <div>
                  <div className="mb-1.5 text-[10px] uppercase tracking-wider text-text-muted">模型</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MODEL_OPTIONS.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        onClick={() => setRoleConfig(activeRole.id, { modelId: model.id })}
                        className={clsx(
                          'rounded-md border px-2 py-2 text-left transition',
                          activeConfig.modelId === model.id
                            ? 'border-accent/45 bg-accent/10 text-text'
                            : 'border-white/5 bg-bg/60 text-text-muted hover:text-text',
                        )}
                      >
                        <span className="block text-xs font-semibold">{model.label}</span>
                        <span className="block text-[10px]">{model.detail}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider text-text-muted">Skills</span>
                    <span className="text-[10px] text-text-muted">会注入到该身份的 system prompt</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {SKILL_LIBRARY.map((skill) => {
                      const active = activeConfig.skillIds.includes(skill.id);
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          onClick={() => toggleSkill(skill.id)}
                          className={clsx(
                            'rounded-full border px-2 py-1 text-[11px] transition',
                            active
                              ? 'border-accent/40 bg-accent/10 text-accent'
                              : 'border-white/5 bg-bg/60 text-text-muted hover:text-text',
                          )}
                          title={skill.prompt}
                        >
                          {skill.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="block">
                  <span className="text-[10px] uppercase tracking-wider text-text-muted">自定义 Skill</span>
                  <textarea
                    value={activeConfig.customSkills}
                    onChange={(e) => setRoleConfig(activeRole.id, { customSkills: e.target.value })}
                    rows={3}
                    placeholder="例如：熟悉 shadcn/ui 和 Radix；所有交互必须先检查键盘可访问性。"
                    className="mt-1 w-full resize-none rounded-md border border-white/10 bg-bg/60 px-2 py-1.5 text-xs leading-relaxed outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
                  />
                </label>
              </div>
            </section>
          </div>
          </div>
        ) : (
          <section className="rounded-lg border border-white/10 bg-bg/35">
            <div className="border-b border-white/5 px-3 py-2">
              <div className="text-xs font-semibold text-text">选择 Agent</div>
              <div className="text-[10px] text-text-muted">单聊使用已有 Agent，不创建项目团队席位。</div>
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto p-2">
              {singleAgents.map((agent) => {
                const checked = singleSelected.has(agent.id);
                return (
                  <button
                    type="button"
                    key={agent.id}
                    onClick={() => selectSingleAgent(agent.id)}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition',
                      checked ? 'border-accent/40 bg-accent/10' : 'border-transparent hover:bg-bg-soft/80',
                    )}
                  >
                    <AgentAvatar name={agent.name} adapterId={agent.adapterId} color={agent.avatarColor} size={28} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{agent.name}</span>
                      <span className="block truncate text-[10px] text-text-muted">
                        {agent.isPublic ? '内置' : '自定义'} · {agent.adapterId}
                        {agent.model ? ` / ${agent.model}` : ''}
                      </span>
                    </span>
                    {checked ? <Check className="h-4 w-4 text-accent" /> : null}
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {type === 'group' ? (
          <label className="block">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-wider text-text-muted">团队协议</span>
              <button
                type="button"
                onClick={() => {
                  setActiveBlueprintId('custom');
                  setGroupRules(DEFAULT_GROUP_RULES);
                }}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
              >
                <Sparkles className="h-2.5 w-2.5" />
                默认模板
              </button>
            </div>
            <textarea
              value={groupRules}
              onChange={(e) => {
                setActiveBlueprintId('custom');
                setGroupRules(e.target.value);
              }}
              rows={4}
              className="w-full resize-none rounded-md border border-white/10 bg-bg/60 px-2 py-1.5 text-xs leading-relaxed outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/10"
            />
          </label>
        ) : null}

        {err ? (
          <div className="rounded-md border border-rose-500/20 bg-rose-500/10 px-2 py-1.5 text-[11px] text-rose-300">
            {err}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-3">
        <div className="text-[10px] text-text-muted">
          {type === 'group'
            ? '创建后会为每个身份生成独立 Agent：身份不变，模型和 Skills 可独立配置。'
            : '单聊不会生成项目 workspace 团队配置。'}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-text-muted hover:bg-white/5 hover:text-text"
          >
            取消
          </button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            创建
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

function TypeBtn({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition',
        active
          ? 'border-accent/40 bg-accent/10 text-text'
          : 'border-white/10 bg-bg/50 text-text-muted hover:border-white/15 hover:text-text',
      )}
    >
      <span className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {label}
      </span>
      <span className="text-[11px] text-text-muted">{hint}</span>
    </button>
  );
}

export function ModalShell({
  onClose,
  title,
  children,
  width = 'w-[480px]',
}: {
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={clsx(
          'rounded-xl border border-white/10 bg-bg-soft shadow-2xl',
          width,
          'max-h-[90vh] overflow-y-auto',
        )}
      >
        <header className="flex items-center justify-between border-b border-white/5 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text">{title}</h2>
            <p className="mt-0.5 text-[10px] text-text-muted">身份、模型、Skills 分开配置。</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-white/5 hover:text-text"
            aria-label="close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
