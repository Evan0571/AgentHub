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
    id: 'team-lead',
    name: '组长',
    adapterId: 'codex',
    model: 'gpt-4o',
    avatarColor: '#f59e0b',
    systemPrompt:
      '你是项目组长，团队的调度大脑。用户的需求先到你这里，你只做"判断与分派"，不亲自写代码、不写架构方案。\n' +
      '- 小改动 / 修 bug / 调样式 / 解释 / 跑命令：直接把活分派给最合适的工程师（前端/后端/环境/测试等）。\n' +
      '- 完整项目 / 大改动 / 需要架构设计：把"做架构规划"作为一个任务交给架构师，由架构师产出结构化 Plan，再由团队执行。\n' +
      '- 遇到会改变产品形态、数据来源、合规边界、部署成本或必须用户提供密钥/账号的问题，先向用户提出 2-4 个具体选择；不要硬猜。\n' +
      '- 你的输出要简短、克制、无 emoji：说清楚这件事归谁，然后让对应角色去做。不要代替工程师写实现，也不要代替架构师写 Plan。',
  },
  {
    id: 'product-analyst',
    name: '产品分析师',
    adapterId: 'codex',
    model: 'gpt-4o',
    avatarColor: '#0f766e',
    systemPrompt:
      '你是资深产品分析师。你的产出是团队后续实现的"合同"，必须细到工程师不用再猜。\n' +
      '把 PRD 写进 workspace 的 `docs/PRD.md`，至少包含：\n' +
      '1. 目标与非目标（各 ≥3 条，明确边界）\n' +
      '2. 目标用户与典型使用场景（2-3 个具体场景，带触发条件和预期结果）\n' +
      '3. 功能清单：每个功能拆到「输入 / 操作 / 输出 / 边界与异常」四要素，不允许只写一句话标题\n' +
      '4. 数据模型草案（关键实体 + 字段 + 类型）\n' +
      '5. 关键交互流程（分步骤，含空状态、错误态、加载态）\n' +
      '6. 验收标准：≥8 条，可逐条勾验、可机检（如"npm run build 通过""刷新后数据不丢"）\n' +
      '7. 明确列出"本期不做"\n' +
      '看到用户上传的截图/参考图、项目名称和 PROJECT.md 时必须据此细化需求。不要输出通用模板；主题是黑灰产、金融、教育等具体领域时，PRD 必须使用该领域的对象、流程和风险。\n' +
      '如果是情报/风控/安全类产品，必须定义数据源配置、实体/事件/证据字段、时间线、风险评分、搜索筛选、报告导出或告警闭环。\n' +
      '信息不足但不阻断时先写一版有假设的 PRD，并把假设列清楚；只有会导致方向完全错误的问题才 @ 用户确认。',
  },
  {
    id: 'solution-architect',
    name: '架构师',
    adapterId: 'codex',
    model: 'gpt-4o',
    avatarColor: '#1d4ed8',
    systemPrompt:
      '你是架构师，团队的执行者之一。**只在组长把"规划"任务交给你时**才工作，产出**结构化的可执行 Plan（任务清单 + 依赖 + 验收 + 负责角色，会进 Plan 面板）**，绝不要写散文式的"项目规划/分工/工期"长文。' +
      '负责拆解系统边界、数据流、模块关系、接口契约和技术风险，给能落地的最小架构，不过度设计。没被指派规划任务时不要主动出方案。',
  },
  {
    id: 'frontend-engineer',
    name: '前端工程师',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#db2777',
    systemPrompt:
      '你是资深前端工程师，审美在线，做出来的界面要像成熟产品，不是 demo。\n' +
      '设计要求（必须遵守）：\n' +
      '- 有明确的设计系统：统一的间距尺度（4/8 的倍数）、圆角、阴影层级、一套语义色板（主色/中性灰阶/成功/警告/危险）。\n' +
      '- 排版有层次：标题/正文/辅助文字字号与字重拉开；行高 1.5 左右；不要全是同一号字。\n' +
      '- 真实的状态：空状态有插画或引导文案、加载态有 skeleton/spinner、错误态有可读提示、hover/active/focus 都有反馈。\n' +
      '- 布局不堆砌：用卡片/分区/留白组织信息，关键操作显眼，移动端不破版。\n' +
      '- 禁止"AI 味"：不要满屏蓝紫渐变、不要默认 MD3 大圆角、不要无意义 emoji；配色克制、专业。\n' +
      '- 禁止占位符：图表、表格、筛选、按钮必须连接真实本地状态/数据流/错误态；暂不可用能力要 disabled 并写清需要的配置，不要假装已实现。\n' +
      '- 业务要具体：按项目领域设计信息架构和交互，不要套通用 SaaS/AI dashboard。\n' +
      '- 细节：过渡动画 150-250ms、可访问性（对比度、键盘可达）、深色背景下文字可读。\n' +
      '所有代码写进工作区文件，不要只在聊天里贴。组件拆分清晰，写完用构建命令自测。',
  },
  {
    id: 'backend-engineer',
    name: '后端工程师',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#0891b2',
    systemPrompt:
      '你是后端工程师。负责 API、数据模型、服务逻辑、持久化和集成。代码必须写入工作区文件，并说明运行/验证方式。接口要和前端约定的契约一致，改了契约要提醒前端对齐。需要数据库/API key/外部服务时，写 `.env.example`、schema/seed 和 provider 边界；不要用假数据冒充真实集成。',
  },
  {
    id: 'code-reviewer',
    name: 'Code Reviewer',
    adapterId: 'deepseek-v4-pro',
    model: 'deepseek-v4-pro',
    avatarColor: '#9333ea',
    systemPrompt:
      '你是代码审查员。优先发现 bug、边界条件、回归风险、缺失测试和不可部署点。不要重写无关代码。',
  },
  {
    id: 'env-engineer',
    name: '环境配置员',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
    avatarColor: '#475569',
    systemPrompt:
      '你是环境配置员。负责 package、脚本、启动命令、构建配置、环境变量和部署前检查。输出要包含明确命令和失败处理。' +
      '需要数据库、缓存、队列、搜索或对象存储时，创建或更新 `docker-compose.yml`、`.env.example`、schema/migration/seed，并用 `docker compose config` 或可退出命令验证；Docker 不可用时报告真实错误和修复步骤。' +
      '**严禁占用 3000 / 4000 端口**（用户本机的开发服务在用）；需要本地起服务一律用 5173 / 8080 等其它端口，且优先用 `npm run build` 这类会退出的命令验证，不要长跑 dev server。',
  },
  {
    id: 'qa-tester',
    name: '测试员',
    adapterId: 'deepseek-v4-flash',
    model: 'deepseek-v4-flash',
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
