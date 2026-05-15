import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { WorkspaceService } from './workspace.service.js';

const WriteFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
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
}
