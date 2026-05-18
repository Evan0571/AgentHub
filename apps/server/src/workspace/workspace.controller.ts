import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { z } from 'zod';
import { WorkspaceService } from './workspace.service.js';

interface ResponseLike {
  setHeader(name: string, value: string): void;
}

const WriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

const UploadFileSchema = z.object({
  name: z.string().min(1).max(240),
  mimeType: z.string().max(160).default('application/octet-stream'),
  base64: z.string().min(1),
});

const TerminalRunSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
});

const PermissionDecisionSchema = z.object({
  note: z.string().max(1000).optional(),
  persist: z.enum(['exact_command', 'cwd_risk']).optional(),
});

const WakeDecisionSchema = z.object({
  note: z.string().max(1000).optional(),
});

@Controller('api/conversations/:conversationId/workspace')
export class WorkspaceController {
  constructor(private readonly workspace: WorkspaceService) {}

  @Get()
  async list(
    @Param('conversationId') conversationId: string,
    @Query('path') relPath?: string,
    @Query('maxFiles') maxFiles?: string,
  ) {
    return await this.workspace.listFiles(conversationId, {
      path: relPath,
      maxFiles: maxFiles ? Number(maxFiles) : undefined,
    });
  }

  @Get('file')
  async read(
    @Param('conversationId') conversationId: string,
    @Query('path') relPath?: string,
    @Query('maxBytes') maxBytes?: string,
  ) {
    if (!relPath) throw new BadRequestException('path is required');
    return await this.workspace.readFile(conversationId, {
      path: relPath,
      maxBytes: maxBytes ? Number(maxBytes) : undefined,
    });
  }

  @Put('file')
  async write(@Param('conversationId') conversationId: string, @Body() body: unknown) {
    const parsed = WriteFileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.writeFile(conversationId, parsed.data);
  }

  @Post('upload')
  async upload(@Param('conversationId') conversationId: string, @Body() body: unknown) {
    const parsed = UploadFileSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.writeUploadedFile(conversationId, parsed.data);
  }

  @Get('raw')
  async raw(
    @Param('conversationId') conversationId: string,
    @Query('path') relPath: string | undefined,
    @Query('mimeType') mimeType: string | undefined,
    @Res({ passthrough: true }) res: ResponseLike,
  ) {
    if (!relPath) throw new BadRequestException('path is required');
    const file = await this.workspace.readBinaryFile(conversationId, {
      path: relPath,
      maxBytes: 10 * 1024 * 1024,
    });
    res.setHeader('Content-Type', mimeType || 'application/octet-stream');
    res.setHeader('Content-Length', String(file.size));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(relPath.split('/').pop() ?? 'file')}"`);
    return new StreamableFile(file.buffer);
  }

  @Delete('file')
  @HttpCode(204)
  async remove(
    @Param('conversationId') conversationId: string,
    @Query('path') relPath?: string,
    @Query('recursive') recursive?: string,
  ): Promise<void> {
    if (!relPath) throw new BadRequestException('path is required');
    await this.workspace.deletePath(conversationId, {
      path: relPath,
      recursive: recursive === 'true',
    });
  }

  @Post('terminal')
  async terminal(@Param('conversationId') conversationId: string, @Body() body: unknown) {
    const parsed = TerminalRunSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.runCommand(conversationId, parsed.data);
  }

  @Get('permissions')
  async permissions(@Param('conversationId') conversationId: string) {
    return await this.workspace.listPermissionRequests(conversationId);
  }

  @Post('permissions/:requestId/approve')
  async approvePermission(
    @Param('conversationId') conversationId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const parsed = PermissionDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.decidePermissionRequest(conversationId, {
      requestId,
      decision: 'approved',
      note: parsed.data.note,
      persist: parsed.data.persist,
    });
  }

  @Post('permissions/:requestId/deny')
  async denyPermission(
    @Param('conversationId') conversationId: string,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ) {
    const parsed = PermissionDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.decidePermissionRequest(conversationId, {
      requestId,
      decision: 'denied',
      note: parsed.data.note,
    });
  }

  @Post('permissions/policies/:policyId/revoke')
  async revokePermissionPolicy(
    @Param('conversationId') conversationId: string,
    @Param('policyId') policyId: string,
    @Body() body: unknown,
  ) {
    const parsed = PermissionDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.revokePermissionPolicy(conversationId, {
      policyId,
      note: parsed.data.note,
    });
  }

  @Get('wake')
  async wakeQueue(
    @Param('conversationId') conversationId: string,
    @Query('target') target?: string,
    @Query('includeResolved') includeResolved?: string,
    @Query('limit') limit?: string,
  ) {
    return await this.workspace.listTeamWakeQueue(conversationId, {
      target,
      includeResolved: includeResolved === 'true',
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('wake/:wakeId/requeue')
  async requeueWake(
    @Param('conversationId') conversationId: string,
    @Param('wakeId') wakeId: string,
    @Body() body: unknown,
  ) {
    const parsed = WakeDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.resolveTeamWake(conversationId, {
      wakeId,
      status: 'pending',
      note: parsed.data.note,
    });
  }

  @Post('wake/:wakeId/cancel')
  async cancelWake(
    @Param('conversationId') conversationId: string,
    @Param('wakeId') wakeId: string,
    @Body() body: unknown,
  ) {
    const parsed = WakeDecisionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return await this.workspace.resolveTeamWake(conversationId, {
      wakeId,
      status: 'cancelled',
      note: parsed.data.note,
    });
  }
}
