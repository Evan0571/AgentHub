import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { users, type Db } from '@agenthub/db';
import { eq } from 'drizzle-orm';
import { DB_TOKEN, DEMO_USER_ID, DEMO_USER_EMAIL } from './constants.js';
import { AgentsRepo } from './agents.repo.js';

/** Built-in agents — public, owner-less, can be invited to any conversation. */
const BUILT_IN_AGENTS = [
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#0f766e',
    systemPrompt: '',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    adapterId: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
    avatarColor: '#2563eb',
    systemPrompt: '',
  },
  {
    id: 'codex',
    name: 'Codex (GPT-4o)',
    adapterId: 'codex',
    avatarColor: '#10b981',
    systemPrompt: '',
  },
  {
    id: 'mock',
    name: 'Mock',
    adapterId: 'mock',
    avatarColor: '#6b7280',
    systemPrompt: '',
  },
  {
    id: 'orchestrator',
    name: 'Orchestrator',
    adapterId: 'orchestrator', // pseudo — handled specially by MentionRouter
    avatarColor: '#f97316',
    systemPrompt: '',
  },
  {
    id: 'product-analyst',
    name: '产品分析师',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#0f766e',
    systemPrompt:
      '你是产品分析师。先澄清用户目标、使用场景、核心功能、非目标和验收标准。输出必须具体、可执行，避免泛泛的 AI 产品话术。',
  },
  {
    id: 'solution-architect',
    name: '架构师',
    adapterId: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
    avatarColor: '#1d4ed8',
    systemPrompt:
      '你是架构师。负责拆解系统边界、数据流、模块关系、接口契约和技术风险。优先给出能落地的最小架构，而不是过度设计。',
  },
  {
    id: 'frontend-engineer',
    name: '前端工程师',
    adapterId: 'codex',
    avatarColor: '#db2777',
    systemPrompt:
      '你是前端工程师。负责实现界面、交互、状态管理和可预览产物。代码必须写入工作区文件，避免只在聊天里贴代码。',
  },
  {
    id: 'backend-engineer',
    name: '后端工程师',
    adapterId: 'codex',
    avatarColor: '#0891b2',
    systemPrompt:
      '你是后端工程师。负责 API、数据模型、服务逻辑、持久化和集成。代码必须写入工作区文件，并说明运行/验证方式。',
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    adapterId: 'codex',
    avatarColor: '#9333ea',
    systemPrompt:
      '你是代码审查员。优先发现 bug、边界条件、回归风险、缺失测试和不可部署点。不要重写无关代码。',
  },
  {
    id: 'env-engineer',
    name: '环境配置员',
    adapterId: 'codex',
    avatarColor: '#475569',
    systemPrompt:
      '你是环境配置员。负责 package、脚本、启动命令、构建配置、环境变量和部署前检查。输出要包含明确命令和失败处理。',
  },
  {
    id: 'qa-tester',
    name: '测试员',
    adapterId: 'codex',
    avatarColor: '#ca8a04',
    systemPrompt:
      '你是测试员。负责制定并执行功能、编译、运行和关键交互验证。优先给出可复现的检查步骤和真实失败信息。',
  },
  {
    id: 'senior-user',
    name: '资深用户',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#16a34a',
    systemPrompt:
      '你是资深用户评估员。站在真实用户角度判断产品是否有用、是否顺手、是否解决问题。反馈要具体到页面、流程和文案。',
  },
  {
    id: 'risk-critic',
    name: '风险审视员',
    adapterId: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
    avatarColor: '#dc2626',
    systemPrompt:
      '你是风险和边界审视员。专门检查安全、隐私、误用、不可行假设、部署风险和范围膨胀。结论要直接，避免空泛提醒。',
  },
];

const RETIRED_BUILT_IN_AGENT_IDS = ['deepseek-v3', 'deepseek-r1'];

@Injectable()
export class SeedService implements OnApplicationBootstrap {
  private readonly log = new Logger('SeedService');

  constructor(
    @Inject(DB_TOKEN) private readonly db: Db,
    private readonly agentsRepo: AgentsRepo,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureDemoUser();
    for (const a of BUILT_IN_AGENTS) {
      await this.agentsRepo.ensureBuiltIn(a);
    }
    await this.agentsRepo.deleteByIds(RETIRED_BUILT_IN_AGENT_IDS);
    this.log.log('seed complete (built-in agents only — user creates own conversations)');
  }

  private async ensureDemoUser(): Promise<void> {
    const found = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, DEMO_USER_ID))
      .limit(1);
    if (found.length > 0) return;
    await this.db.insert(users).values({
      id: DEMO_USER_ID,
      email: DEMO_USER_EMAIL,
    });
    this.log.log(`inserted demo user ${DEMO_USER_ID}`);
  }
}
