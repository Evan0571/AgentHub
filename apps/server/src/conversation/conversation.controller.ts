import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { z } from 'zod';
import type { Plan } from '@agenthub/shared-types';
import { MessagesRepo, type PersistedMessage } from '../db/messages.repo.js';
import { ConversationsRepo, type ConversationSummary } from '../db/conversations.repo.js';
import { AgentsRepo, type AgentDescriptor } from '../db/agents.repo.js';
import { PlanService } from '../orchestrator/plan.service.js';
import { AdapterFactoryService } from '../adapter/adapter.factory.js';
import { WorkspaceService } from '../workspace/workspace.service.js';
import { UsageRepo, type ConversationUsageSummary } from '../db/usage.repo.js';

export interface ConversationStateResponse {
  conversationId: string;
  messages: PersistedMessage[];
  plan: Plan | null;
}

const CreateConversationSchema = z.object({
  type: z.enum(['single', 'group']),
  title: z.string().min(1).max(120),
  // Match the DB column: nullable + optional. Empty / null means "no group prompt".
  groupSystemPrompt: z.string().max(4000).nullable().optional(),
  memberAgentIds: z.array(z.string()).default([]),
  memberConfigs: z
    .array(
      z.object({
        roleAgentId: z.string().min(1).max(120),
        adapterId: z.string().min(1).max(120),
        model: z.string().max(160).nullable().optional(),
        skills: z
          .array(
            z.object({
              id: z.string().min(1).max(80),
              label: z.string().min(1).max(80),
              prompt: z.string().min(1).max(1200),
            }),
          )
          .default([]),
        customSkills: z.string().max(2000).nullable().optional(),
      }),
    )
    .default([]),
});

const AddMemberSchema = z.object({
  agentId: z.string().min(1),
});

const UpdateConversationSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  groupSystemPrompt: z.string().max(4000).nullable().optional(),
});

const CreateAgentSchema = z.object({
  name: z.string().min(1).max(60),
  adapterId: z.string().min(1),
  systemPrompt: z.string().max(8000).default(''),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#6366f1'),
  model: z.string().nullable().optional(),
  apiKey: z.string().max(4000).nullable().optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
});

const UpdateAgentSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  systemPrompt: z.string().max(8000).optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  model: z.string().nullable().optional(),
  /** Empty string clears the saved key; null leaves untouched (omit). */
  apiKey: z.string().max(4000).nullable().optional(),
  baseUrl: z.string().url().max(500).nullable().optional(),
});

/** REST surface for conversations / members / agents + per-conversation hydration. */
@Controller('api')
export class ConversationController {
  constructor(
    private readonly messages: MessagesRepo,
    private readonly plans: PlanService,
    private readonly convs: ConversationsRepo,
    private readonly agents: AgentsRepo,
    private readonly adapterFactory: AdapterFactoryService,
    private readonly workspace: WorkspaceService,
    private readonly usage: UsageRepo,
  ) {}

  // ----- conversations ----------------------------------------------------

  @Get('conversations')
  async list(): Promise<ConversationSummary[]> {
    return this.convs.listForUser();
  }

  @Post('conversations')
  async create(@Body() body: unknown): Promise<ConversationSummary> {
    const parsed = CreateConversationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const configuredMembers =
      parsed.data.type === 'group' ? parsed.data.memberConfigs : [];
    const conv = await this.convs.create({
      type: parsed.data.type,
      title: parsed.data.title,
      groupSystemPrompt: parsed.data.groupSystemPrompt ?? null,
      memberAgentIds: configuredMembers.length > 0 ? [] : parsed.data.memberAgentIds,
    });
    const configuredMemberIds: string[] = [];
    for (const cfg of configuredMembers) {
      const template = await this.agents.getById(cfg.roleAgentId);
      if (!template) throw new NotFoundException(`role agent ${cfg.roleAgentId} not found`);
      const scoped = await this.agents.create({
        id: `conv-agent-${conv.id}-${cfg.roleAgentId}`,
        name: template.name,
        adapterId: cfg.adapterId,
        model: cfg.model ?? null,
        systemPrompt: composeRoleSystemPrompt({
          basePrompt: template.systemPrompt,
          roleName: template.name,
          modelLabel: cfg.model ?? cfg.adapterId,
          skills: cfg.skills,
          customSkills: cfg.customSkills ?? null,
        }),
        avatarColor: template.avatarColor,
        isPublic: false,
      });
      configuredMemberIds.push(scoped.id);
      await this.convs.addMember(conv.id, scoped.id);
    }
    if (parsed.data.type === 'group') {
      await this.workspace.initializeProject(conv.id, {
        title: parsed.data.title,
        memberIds: configuredMembers.length > 0 ? configuredMemberIds : parsed.data.memberAgentIds,
      });
    }
    return (await this.convs.getById(conv.id)) ?? conv;
  }

  @Put('conversations/:id')
  async update(@Param('id') id: string, @Body() body: unknown): Promise<ConversationSummary> {
    const parsed = UpdateConversationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const realId = this.messages.resolveConversationUuid(id) ?? id;
    if (parsed.data.title !== undefined) await this.convs.updateTitle(realId, parsed.data.title);
    if (parsed.data.groupSystemPrompt !== undefined) {
      await this.convs.updateGroupSystemPrompt(realId, parsed.data.groupSystemPrompt);
    }
    const conv = await this.convs.getById(realId);
    if (!conv) throw new NotFoundException();
    return conv;
  }

  @Delete('conversations/:id')
  @HttpCode(204)
  async remove(@Param('id') id: string): Promise<void> {
    await this.convs.delete(id);
    await this.agents.deleteScopedForConversation(id);
  }

  @Get('conversations/:id/state')
  async getState(@Param('id') id: string): Promise<ConversationStateResponse> {
    const realId = this.messages.resolveConversationUuid(id) ?? id;
    const [msgs, plan] = await Promise.all([
      this.messages.list(realId),
      this.plans.latestForConversation(realId),
    ]);
    return {
      conversationId: id,
      messages: msgs,
      plan: plan ?? null,
    };
  }

  @Get('conversations/:id/usage')
  async getUsage(@Param('id') id: string): Promise<ConversationUsageSummary> {
    const realId = this.messages.resolveConversationUuid(id) ?? id;
    return this.usage.summaryForConversation(realId);
  }

  // ----- members ----------------------------------------------------------

  @Post('conversations/:id/members')
  async addMember(@Param('id') id: string, @Body() body: unknown): Promise<ConversationSummary> {
    const parsed = AddMemberSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const realId = this.messages.resolveConversationUuid(id) ?? id;
    const exists = await this.agents.exists(parsed.data.agentId);
    if (!exists) throw new NotFoundException(`agent ${parsed.data.agentId} not found`);
    await this.convs.addMember(realId, parsed.data.agentId);
    const conv = await this.convs.getById(realId);
    if (!conv) throw new NotFoundException();
    return conv;
  }

  @Delete('conversations/:id/members/:agentId')
  @HttpCode(204)
  async removeMember(@Param('id') id: string, @Param('agentId') agentId: string): Promise<void> {
    const realId = this.messages.resolveConversationUuid(id) ?? id;
    await this.convs.removeMember(realId, agentId);
  }

  // ----- agents -----------------------------------------------------------

  @Get('agents')
  async listAgents(): Promise<AgentDescriptor[]> {
    return this.agents.listAvailable();
  }

  @Post('agents')
  async createAgent(@Body() body: unknown): Promise<AgentDescriptor> {
    const parsed = CreateAgentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.agents.create({
      name: parsed.data.name,
      adapterId: parsed.data.adapterId,
      systemPrompt: parsed.data.systemPrompt,
      avatarColor: parsed.data.avatarColor,
      model: parsed.data.model ?? null,
      apiKey: parsed.data.apiKey ?? null,
      baseUrl: parsed.data.baseUrl ?? null,
    });
  }

  @Put('agents/:id')
  async updateAgent(@Param('id') id: string, @Body() body: unknown): Promise<AgentDescriptor> {
    const parsed = UpdateAgentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const updated = await this.agents.update(id, parsed.data);
    if (!updated) throw new NotFoundException();
    // Drop any cached adapter instance — key / model / baseUrl may have changed.
    this.adapterFactory.invalidate(id);
    return updated;
  }

  @Delete('agents/:id')
  @HttpCode(204)
  async deleteAgent(@Param('id') id: string): Promise<void> {
    await this.agents.delete(id);
    this.adapterFactory.invalidate(id);
  }
}

function composeRoleSystemPrompt(input: {
  basePrompt: string;
  roleName: string;
  modelLabel: string;
  skills: Array<{ id: string; label: string; prompt: string }>;
  customSkills: string | null;
}): string {
  const blocks = [
    input.basePrompt.trim(),
    `## 运行配置\n- 身份：${input.roleName}\n- 模型：${input.modelLabel}\n- 工作方式：按身份职责输出，不要冒充其他成员；需要文件或命令时优先使用 workspace/terminal 工具。`,
  ].filter(Boolean);

  if (input.skills.length > 0 || input.customSkills?.trim()) {
    const skillBlocks = input.skills.map((s) => `### ${s.label}\n${s.prompt.trim()}`);
    if (input.customSkills?.trim()) {
      skillBlocks.push(`### 自定义 Skill\n${input.customSkills.trim()}`);
    }
    blocks.push(`## Skills\n${skillBlocks.join('\n\n')}`);
  }

  return blocks.join('\n\n');
}
