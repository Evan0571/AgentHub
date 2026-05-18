import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, open, mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import type { ToolSchema } from '@agenthub/adapter-core';
import type { Plan, PlanTask, TaskStatus } from '@agenthub/shared-types';

const TASK_BOARD_PATH = '.agenthub/TASK_BOARD.json';
const TEAM_MAILBOX_PATH = '.agenthub/TEAM_MAILBOX.json';
const TEAM_WAKE_QUEUE_PATH = '.agenthub/TEAM_WAKE_QUEUE.json';
const PERMISSIONS_PATH = '.agenthub/PERMISSIONS.json';
const LOCAL_MEMORY_PATH = '.agenthub/memory/LOCAL.md';
const AGENT_MEMORY_DIR = '.agenthub/memory/agents';
const DEFAULT_WAKE_MAX_ATTEMPTS = 3;

@Injectable()
export class WorkspaceService {
  private readonly rootDir = path.resolve(
    process.env.AGENTHUB_WORKSPACE_ROOT ?? path.join(process.cwd(), '.agenthub-workspaces'),
  );

  getRootDir(): string {
    return this.rootDir;
  }

  getConversationRoot(conversationId: string): string {
    const safeId = sanitizeConversationId(conversationId);
    const dir = path.resolve(this.rootDir, safeId);
    assertInside(this.rootDir, dir);
    return dir;
  }

  async ensureWorkspace(conversationId: string): Promise<string> {
    const dir = this.getConversationRoot(conversationId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async initializeProject(
    conversationId: string,
    input: { title: string; memberIds?: string[] },
  ): Promise<void> {
    await this.ensureWorkspace(conversationId);
    await this.writeFileIfMissing(conversationId, 'TEAM_MEMORY.md', [
      '# Team Memory',
      '',
      '## Decisions',
      '',
      '- 记录会影响多个 Agent 的产品、架构、接口、数据模型和验收决策。',
      '',
      '## Open Questions',
      '',
      '- 记录需要用户回答、需要外部凭据或会改变方向的问题。',
      '',
      '## Environment',
      '',
      '- 记录 .env 变量、Docker 服务、端口、启动命令和本地依赖。',
      '',
      '## Handoffs',
      '',
      '- 记录跨角色交接：谁改了什么、影响谁、下一位 Agent 应先读哪些文件。',
      '',
    ].join('\n'));

    const docPath = 'PROJECT.md';
    const abs = this.resolveInside(conversationId, docPath);

    try {
      await stat(abs);
      return;
    } catch {
      // First project setup: create the editable project anchor below.
    }

    const memberList =
      input.memberIds && input.memberIds.length > 0
        ? input.memberIds.map((id) => `- ${id}`).join('\n')
        : '- 待配置';

    await this.writeFile(conversationId, {
      path: docPath,
      content: [
        `# ${input.title}`,
        '',
        '## 项目目标',
        '',
        '- 在这里补充最终要交付的产品、范围和验收标准。',
        '',
        '## 团队成员',
        '',
        memberList,
        '',
        '## 当前状态',
        '',
        '- 项目工作区已创建，后续 Agent 的代码、文档和验证记录都应写入这里。',
        '',
      ].join('\n'),
    });
  }

  private async writeFileIfMissing(conversationId: string, filePath: string, content: string): Promise<void> {
    const abs = this.resolveInside(conversationId, filePath);
    try {
      await stat(abs);
      return;
    } catch {
      await this.writeFile(conversationId, { path: filePath, content });
    }
  }

  async listFiles(conversationId: string, input: { path?: string; maxFiles?: number } = {}): Promise<WorkspaceListResult> {
    const root = await this.ensureWorkspace(conversationId);
    const start = this.resolveInside(conversationId, input.path ?? '');
    const maxFiles = clampInt(input.maxFiles ?? 300, 1, 1000);
    const entries: WorkspaceFileEntry[] = [];

    async function walk(absDir: string, relDir: string): Promise<void> {
      if (entries.length >= maxFiles) return;
      const dirents = await readdir(absDir, { withFileTypes: true });
      dirents.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const dirent of dirents) {
        if (entries.length >= maxFiles) return;
        if (shouldIgnore(dirent.name)) continue;

        const abs = path.join(absDir, dirent.name);
        const rel = toPosixPath(path.relative(root, abs));
        const s = await stat(abs);
        const entry: WorkspaceFileEntry = {
          path: rel,
          type: dirent.isDirectory() ? 'directory' : 'file',
          size: dirent.isDirectory() ? undefined : s.size,
          mtime: s.mtime.toISOString(),
        };
        entries.push(entry);
        if (dirent.isDirectory()) {
          await walk(abs, relDir ? `${relDir}/${dirent.name}` : dirent.name);
        }
      }
    }

    const s = await stat(start).catch(() => null);
    if (!s) {
      return { root, files: [], truncated: false };
    }
    if (s.isDirectory()) {
      await walk(start, input.path ?? '');
    } else {
      entries.push({
        path: toPosixPath(path.relative(root, start)),
        type: 'file',
        size: s.size,
        mtime: s.mtime.toISOString(),
      });
    }

    return { root, files: entries, truncated: entries.length >= maxFiles };
  }

  async readFile(conversationId: string, input: { path: string; maxBytes?: number }): Promise<WorkspaceReadResult> {
    const abs = this.resolveInside(conversationId, input.path);
    const s = await stat(abs).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) {
        throw new NotFoundException(`Workspace file not found: ${input.path}`);
      }
      throw error;
    });
    if (!s.isFile()) throw new NotFoundException(`Workspace file not found: ${input.path}`);

    const maxBytes = clampInt(input.maxBytes ?? 200_000, 1, 1_000_000);
    const bytesToRead = Math.min(s.size, maxBytes);
    const handle = await open(abs, 'r');
    try {
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
      const content = buffer.subarray(0, bytesRead).toString('utf8');
      return {
        path: toPosixPath(path.relative(this.getConversationRoot(conversationId), abs)),
        content,
        size: s.size,
        truncated: s.size > maxBytes,
        sha256: createHash('sha256').update(content).digest('hex'),
      };
    } finally {
      await handle.close();
    }
  }

  async writeFile(conversationId: string, input: { path: string; content: string }): Promise<WorkspaceWriteResult> {
    const abs = this.resolveInside(conversationId, input.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.content, 'utf8');
    const s = await stat(abs);
    return {
      path: toPosixPath(path.relative(this.getConversationRoot(conversationId), abs)),
      size: s.size,
      mtime: s.mtime.toISOString(),
    };
  }

  async writeBinaryFile(
    conversationId: string,
    input: { path: string; buffer: Buffer },
  ): Promise<WorkspaceWriteResult> {
    const abs = this.resolveInside(conversationId, input.path);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, input.buffer);
    const s = await stat(abs);
    return {
      path: toPosixPath(path.relative(this.getConversationRoot(conversationId), abs)),
      size: s.size,
      mtime: s.mtime.toISOString(),
    };
  }

  async writeUploadedFile(
    conversationId: string,
    input: { name: string; mimeType: string; base64: string },
  ): Promise<WorkspaceUploadResult> {
    const buffer = decodeBase64Payload(input.base64);
    if (buffer.length > 10 * 1024 * 1024) {
      throw new BadRequestException('File is too large; max upload size is 10 MB');
    }
    const safeName = sanitizeFilename(input.name);
    const day = new Date().toISOString().slice(0, 10);
    const stamp = Date.now().toString(36);
    const path = `attachments/${day}/${stamp}-${safeName}`;
    const written = await this.writeBinaryFile(conversationId, { path, buffer });
    return {
      id: `${stamp}-${Math.random().toString(36).slice(2, 8)}`,
      name: safeName,
      path: written.path,
      mimeType: input.mimeType || 'application/octet-stream',
      size: written.size,
      kind: attachmentKind(input.mimeType, safeName),
    };
  }

  async readBinaryFile(
    conversationId: string,
    input: { path: string; maxBytes?: number },
  ): Promise<WorkspaceBinaryReadResult> {
    const abs = this.resolveInside(conversationId, input.path);
    const s = await stat(abs).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) {
        throw new NotFoundException(`Workspace file not found: ${input.path}`);
      }
      throw error;
    });
    if (!s.isFile()) throw new NotFoundException(`Workspace file not found: ${input.path}`);
    const maxBytes = clampInt(input.maxBytes ?? 10 * 1024 * 1024, 1, 10 * 1024 * 1024);
    if (s.size > maxBytes) {
      throw new BadRequestException(`File exceeds maxBytes: ${input.path}`);
    }
    const handle = await open(abs, 'r');
    try {
      const buffer = Buffer.alloc(s.size);
      const { bytesRead } = await handle.read(buffer, 0, s.size, 0);
      return {
        path: toPosixPath(path.relative(this.getConversationRoot(conversationId), abs)),
        buffer: buffer.subarray(0, bytesRead),
        size: s.size,
        sha256: createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('hex'),
      };
    } finally {
      await handle.close();
    }
  }

  async readFiles(
    conversationId: string,
    input: { files: Array<{ path: string; maxBytes?: number }> },
  ): Promise<WorkspaceBatchReadResult> {
    const files = await Promise.all(
      input.files.slice(0, 20).map(async (file) => {
        try {
          return {
            ok: true as const,
            value: await this.readFile(conversationId, file),
          };
        } catch (error) {
          return {
            ok: false as const,
            path: file.path,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { count: files.length, files };
  }

  async writeFiles(
    conversationId: string,
    input: { files: Array<{ path: string; content: string }> },
  ): Promise<WorkspaceBatchWriteResult> {
    const files = await Promise.all(
      input.files.slice(0, 30).map(async (file) => {
        try {
          return {
            ok: true as const,
            value: await this.writeFile(conversationId, file),
          };
        } catch (error) {
          return {
            ok: false as const,
            path: file.path,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    return { count: files.length, files };
  }

  async deletePath(conversationId: string, input: { path: string; recursive?: boolean }): Promise<WorkspaceDeleteResult> {
    if (!input.path || input.path === '.') {
      throw new Error('Refusing to delete the workspace root');
    }
    const abs = this.resolveInside(conversationId, input.path);
    const s = await stat(abs).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) {
        throw new NotFoundException(`Workspace path not found: ${input.path}`);
      }
      throw error;
    });
    if (s.isDirectory()) {
      if (!input.recursive) throw new Error('Directory delete requires recursive=true');
      await rm(abs, { recursive: true, force: true });
    } else {
      await unlink(abs);
    }
    return { path: input.path, deleted: true };
  }

  async readTaskBoard(conversationId: string): Promise<TeamTaskBoard> {
    const read = await this.readFile(conversationId, { path: TASK_BOARD_PATH, maxBytes: 500_000 }).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    if (!read) {
      const board = createEmptyTaskBoard(conversationId);
      await this.writeTaskBoard(conversationId, board);
      return board;
    }

    try {
      return normalizeTaskBoard(JSON.parse(read.content), conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`${TASK_BOARD_PATH} is not valid task board JSON: ${message}`);
    }
  }

  private async writeTaskBoard(conversationId: string, board: TeamTaskBoard): Promise<WorkspaceWriteResult> {
    return await this.writeFile(conversationId, {
      path: TASK_BOARD_PATH,
      content: `${JSON.stringify(board, null, 2)}\n`,
    });
  }

  private async loadTeamMailbox(conversationId: string): Promise<TeamMailbox> {
    const read = await this.readFile(conversationId, { path: TEAM_MAILBOX_PATH, maxBytes: 500_000 }).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    if (!read) {
      const mailbox = createEmptyTeamMailbox(conversationId);
      await this.writeTeamMailbox(conversationId, mailbox);
      return mailbox;
    }

    try {
      return normalizeTeamMailbox(JSON.parse(read.content), conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`${TEAM_MAILBOX_PATH} is not valid mailbox JSON: ${message}`);
    }
  }

  private async writeTeamMailbox(conversationId: string, mailbox: TeamMailbox): Promise<WorkspaceWriteResult> {
    return await this.writeFile(conversationId, {
      path: TEAM_MAILBOX_PATH,
      content: `${JSON.stringify(mailbox, null, 2)}\n`,
    });
  }

  private async loadTeamWakeQueue(conversationId: string): Promise<TeamWakeQueue> {
    const read = await this.readFile(conversationId, { path: TEAM_WAKE_QUEUE_PATH, maxBytes: 500_000 }).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    if (!read) {
      const queue = createEmptyTeamWakeQueue(conversationId);
      await this.writeTeamWakeQueue(conversationId, queue);
      return queue;
    }

    try {
      return normalizeTeamWakeQueue(JSON.parse(read.content), conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`${TEAM_WAKE_QUEUE_PATH} is not valid wake queue JSON: ${message}`);
    }
  }

  private async writeTeamWakeQueue(conversationId: string, queue: TeamWakeQueue): Promise<WorkspaceWriteResult> {
    return await this.writeFile(conversationId, {
      path: TEAM_WAKE_QUEUE_PATH,
      content: `${JSON.stringify(queue, null, 2)}\n`,
    });
  }

  private async loadPermissionQueue(conversationId: string): Promise<WorkspacePermissionQueue> {
    const read = await this.readFile(conversationId, { path: PERMISSIONS_PATH, maxBytes: 500_000 }).catch((error: unknown) => {
      if (error instanceof NotFoundException) return null;
      throw error;
    });
    if (!read) {
      const queue = createEmptyPermissionQueue(conversationId);
      await this.writePermissionQueue(conversationId, queue);
      return queue;
    }

    try {
      return normalizePermissionQueue(JSON.parse(read.content), conversationId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`${PERMISSIONS_PATH} is not valid permission JSON: ${message}`);
    }
  }

  private async writePermissionQueue(conversationId: string, queue: WorkspacePermissionQueue): Promise<WorkspaceWriteResult> {
    return await this.writeFile(conversationId, {
      path: PERMISSIONS_PATH,
      content: `${JSON.stringify(queue, null, 2)}\n`,
    });
  }

  async syncTaskBoardFromPlan(conversationId: string, plan: Plan): Promise<TeamTaskBoard> {
    const current = await this.readTaskBoard(conversationId).catch(() => createEmptyTaskBoard(conversationId));
    const now = new Date().toISOString();
    const existingById = new Map(current.tasks.map((task) => [task.id, task] as const));
    const planTaskIds = new Set(plan.tasks.map((task) => task.id));

    const tasks = plan.tasks.map((task) => taskBoardItemFromPlanTask(task, existingById.get(task.id), now));
    for (const task of current.tasks) {
      if (!task.sourcePlanTaskId && !planTaskIds.has(task.id)) {
        tasks.push({ ...task, updatedAt: task.updatedAt || now });
      }
    }

    const board: TeamTaskBoard = {
      version: 1,
      conversationId,
      updatedAt: now,
      tasks,
    };
    await this.writeTaskBoard(conversationId, board);
    return board;
  }

  async updateTaskBoard(
    conversationId: string,
    input: {
      taskId: string;
      status?: TeamTaskBoardStatus;
      owner?: string;
      title?: string;
      details?: string;
      blocker?: string;
      handoff?: string;
      note?: string;
      artifactPath?: string;
    },
  ): Promise<TaskBoardUpdateResult> {
    const taskId = input.taskId.trim();
    if (!taskId) throw new BadRequestException('taskId is required');

    const board = await this.readTaskBoard(conversationId);
    const now = new Date().toISOString();
    let task = board.tasks.find((item) => item.id === taskId);
    if (!task) {
      task = {
        id: taskId,
        title: input.title?.trim() || taskId,
        status: input.status ?? 'pending',
        dependencies: [],
        notes: [],
        artifactPaths: [],
        updatedAt: now,
      };
      board.tasks.push(task);
    }

    if (input.status) task.status = input.status;
    if (input.owner !== undefined) task.owner = input.owner.trim() || undefined;
    if (input.title !== undefined) task.title = input.title.trim() || task.title;
    if (input.details !== undefined) task.details = input.details.trim() || undefined;
    if (input.blocker !== undefined) task.blocker = input.blocker.trim() || undefined;
    if (input.handoff !== undefined) task.handoff = input.handoff.trim() || undefined;
    if (input.artifactPath && !task.artifactPaths?.includes(input.artifactPath)) {
      task.artifactPaths = [...(task.artifactPaths ?? []), input.artifactPath];
    }
    if (input.note?.trim()) {
      task.notes = [
        ...(task.notes ?? []),
        {
          text: input.note.trim(),
          createdAt: now,
        },
      ].slice(-30);
    }
    task.updatedAt = now;
    board.updatedAt = now;

    await this.writeTaskBoard(conversationId, board);
    return { path: TASK_BOARD_PATH, board, task };
  }

  async readTeamMailbox(
    conversationId: string,
    input: { recipient?: string; includeRead?: boolean; limit?: number } = {},
  ): Promise<TeamMailboxListResult> {
    const mailbox = await this.loadTeamMailbox(conversationId);
    const recipient = input.recipient?.trim().toLowerCase();
    const limit = clampInt(input.limit ?? 50, 1, 200);
    let messages = mailbox.messages;
    if (recipient) {
      messages = messages.filter((message) => {
        const to = message.to.toLowerCase();
        return to === recipient || to === 'all' || to === 'team' || to === '*';
      });
    }
    if (!input.includeRead) {
      messages = messages.filter((message) => !message.readAt);
    }
    messages = messages
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return { path: TEAM_MAILBOX_PATH, messages };
  }

  async sendTeamMessage(
    conversationId: string,
    input: {
      to: string;
      subject: string;
      body: string;
      fromAgentId?: string;
      fromAgentName?: string;
      taskId?: string;
      priority?: TeamMessagePriority;
    },
  ): Promise<TeamMessageSendResult> {
    const to = input.to.trim();
    const subject = input.subject.trim();
    const body = input.body.trim();
    if (!to) throw new BadRequestException('to is required');
    if (!subject) throw new BadRequestException('subject is required');
    if (!body) throw new BadRequestException('body is required');

    const mailbox = await this.loadTeamMailbox(conversationId);
    const now = new Date().toISOString();
    const message: TeamMailboxMessage = {
      id: `tm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      fromAgentId: optionalNonEmptyString(input.fromAgentId),
      fromAgentName: optionalNonEmptyString(input.fromAgentName) ?? 'agent',
      to,
      subject,
      body,
      taskId: optionalNonEmptyString(input.taskId),
      priority: input.priority ?? 'normal',
      createdAt: now,
    };
    mailbox.messages.push(message);
    mailbox.updatedAt = now;
    await this.writeTeamMailbox(conversationId, mailbox);
    await this.enqueueTeamWake(conversationId, {
      messageId: message.id,
      to: message.to,
      subject: message.subject,
      priority: message.priority,
      taskId: message.taskId,
    });
    return { path: TEAM_MAILBOX_PATH, message };
  }

  async listTeamWakeQueue(
    conversationId: string,
    input: { target?: string; includeResolved?: boolean; limit?: number } = {},
  ): Promise<TeamWakeQueueListResult> {
    const queue = await this.loadTeamWakeQueue(conversationId);
    const target = input.target?.trim().toLowerCase();
    const limit = clampInt(input.limit ?? 50, 1, 200);
    let wakeups = queue.wakeups;
    if (target) {
      wakeups = wakeups.filter((item) => item.target.toLowerCase() === target || item.target === 'team' || item.target === '*');
    }
    if (!input.includeResolved) {
      wakeups = wakeups.filter((item) => item.status === 'pending');
    }
    return {
      path: TEAM_WAKE_QUEUE_PATH,
      wakeups: wakeups.slice().sort(sortTeamWakeRequests).slice(0, limit),
    };
  }

  async recoverStaleTeamWakeClaims(
    conversationId: string,
    input: { staleMs?: number } = {},
  ): Promise<TeamWakeQueueListResult> {
    const queue = await this.loadTeamWakeQueue(conversationId);
    const staleMs = clampInt(input.staleMs ?? 5 * 60 * 1000, 30_000, 60 * 60 * 1000);
    const cutoff = Date.now() - staleMs;
    const now = new Date().toISOString();
    const recovered: TeamWakeRequest[] = [];

    for (const item of queue.wakeups) {
      if (item.status !== 'claimed') continue;
      const updatedAt = Date.parse(item.updatedAt);
      if (Number.isFinite(updatedAt) && updatedAt > cutoff) continue;

      const maxAttempts = item.maxAttempts ?? DEFAULT_WAKE_MAX_ATTEMPTS;
      const attempts = (item.attempts ?? 0) + 1;
      item.attempts = attempts;
      item.maxAttempts = maxAttempts;
      item.lastError = 'Wake claim timed out before completion.';
      item.status = attempts >= maxAttempts ? 'failed' : 'pending';
      item.nextRunAt = attempts >= maxAttempts ? undefined : now;
      item.statusNote = attempts >= maxAttempts ? 'stale claim reached max attempts' : 'recovered stale claimed wake';
      item.updatedAt = now;
      recovered.push(item);
    }

    if (recovered.length > 0) {
      queue.updatedAt = now;
      await this.writeTeamWakeQueue(conversationId, queue);
    }

    return {
      path: TEAM_WAKE_QUEUE_PATH,
      wakeups: recovered,
    };
  }

  async resolveTeamWake(
    conversationId: string,
    input: { wakeId: string; status: TeamWakeStatus; agentId?: string; agentName?: string; note?: string },
  ): Promise<TeamWakeQueueItemResult> {
    const queue = await this.loadTeamWakeQueue(conversationId);
    const item = queue.wakeups.find((wake) => wake.id === input.wakeId);
    if (!item) throw new NotFoundException(`Wake request not found: ${input.wakeId}`);
    const now = new Date().toISOString();
    item.status = input.status;
    item.claimedByAgentId = optionalNonEmptyString(input.agentId) ?? item.claimedByAgentId;
    item.claimedByAgentName = optionalNonEmptyString(input.agentName) ?? item.claimedByAgentName;
    item.statusNote = optionalNonEmptyString(input.note) ?? item.statusNote;
    if (input.status === 'pending') {
      item.attempts = 0;
      item.lastError = undefined;
      item.nextRunAt = undefined;
      item.statusNote = optionalNonEmptyString(input.note);
    }
    item.updatedAt = now;
    queue.updatedAt = now;
    await this.writeTeamWakeQueue(conversationId, queue);
    return { path: TEAM_WAKE_QUEUE_PATH, wakeup: item };
  }

  async recordTeamWakeFailure(
    conversationId: string,
    input: { wakeId: string; error: string; agentId?: string; agentName?: string },
  ): Promise<TeamWakeQueueItemResult> {
    const queue = await this.loadTeamWakeQueue(conversationId);
    const item = queue.wakeups.find((wake) => wake.id === input.wakeId);
    if (!item) throw new NotFoundException(`Wake request not found: ${input.wakeId}`);
    const now = new Date().toISOString();
    const maxAttempts = item.maxAttempts ?? DEFAULT_WAKE_MAX_ATTEMPTS;
    const attempts = (item.attempts ?? 0) + 1;
    item.attempts = attempts;
    item.maxAttempts = maxAttempts;
    item.claimedByAgentId = optionalNonEmptyString(input.agentId) ?? item.claimedByAgentId;
    item.claimedByAgentName = optionalNonEmptyString(input.agentName) ?? item.claimedByAgentName;
    item.lastError = input.error.slice(0, 1000);
    item.status = attempts >= maxAttempts ? 'failed' : 'pending';
    item.nextRunAt = attempts >= maxAttempts ? undefined : new Date(Date.now() + wakeRetryDelayMs(attempts)).toISOString();
    item.updatedAt = now;
    queue.updatedAt = now;
    await this.writeTeamWakeQueue(conversationId, queue);
    return { path: TEAM_WAKE_QUEUE_PATH, wakeup: item };
  }

  private async enqueueTeamWake(
    conversationId: string,
    input: { messageId: string; to: string; subject: string; priority: TeamMessagePriority; taskId?: string },
  ): Promise<TeamWakeRequest | null> {
    if (isBroadcastWakeTarget(input.to)) return null;
    const queue = await this.loadTeamWakeQueue(conversationId);
    const existing = queue.wakeups.find(
      (item) => item.status === 'pending' && item.messageId === input.messageId,
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const wakeup: TeamWakeRequest = {
      id: `wake_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      messageId: input.messageId,
      target: input.to,
      subject: input.subject,
      priority: input.priority,
      taskId: input.taskId,
      status: 'pending',
      attempts: 0,
      maxAttempts: DEFAULT_WAKE_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    };
    queue.wakeups.push(wakeup);
    queue.updatedAt = now;
    await this.writeTeamWakeQueue(conversationId, queue);
    return wakeup;
  }

  async markTeamMessagesRead(
    conversationId: string,
    input: { ids: string[] },
  ): Promise<TeamMailboxListResult> {
    const mailbox = await this.loadTeamMailbox(conversationId);
    const ids = new Set(input.ids.map((id) => id.trim()).filter(Boolean));
    const now = new Date().toISOString();
    for (const message of mailbox.messages) {
      if (ids.has(message.id)) message.readAt = now;
    }
    mailbox.updatedAt = now;
    await this.writeTeamMailbox(conversationId, mailbox);
    return { path: TEAM_MAILBOX_PATH, messages: mailbox.messages.filter((message) => ids.has(message.id)) };
  }

  async listPermissionRequests(conversationId: string): Promise<WorkspacePermissionListResult> {
    const queue = await this.loadPermissionQueue(conversationId);
    return {
      path: PERMISSIONS_PATH,
      requests: queue.requests.slice().sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)),
      policies: queue.policies.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  async decidePermissionRequest(
    conversationId: string,
    input: { requestId: string; decision: 'approved' | 'denied'; note?: string; persist?: WorkspacePermissionPolicyScope },
  ): Promise<WorkspacePermissionDecisionResult> {
    const queue = await this.loadPermissionQueue(conversationId);
    const request = queue.requests.find((item) => item.id === input.requestId);
    if (!request) throw new NotFoundException(`Permission request not found: ${input.requestId}`);
    if (request.status !== 'pending') {
      return { path: PERMISSIONS_PATH, request };
    }
    const now = new Date().toISOString();
    request.status = input.decision;
    request.decidedAt = now;
    request.decisionNote = input.note?.trim() || undefined;
    let policy: WorkspacePermissionPolicy | undefined;
    if (input.decision === 'approved' && input.persist) {
      policy = createPermissionPolicy(conversationId, request, input.persist, input.note);
      queue.policies.push(policy);
      request.persistedPolicyId = policy.id;
      request.persistedScope = policy.scope;
    }
    queue.updatedAt = now;
    await this.writePermissionQueue(conversationId, queue);
    return { path: PERMISSIONS_PATH, request, policy };
  }

  async revokePermissionPolicy(
    conversationId: string,
    input: { policyId: string; note?: string },
  ): Promise<WorkspacePermissionPolicyResult> {
    const queue = await this.loadPermissionQueue(conversationId);
    const policy = queue.policies.find((item) => item.id === input.policyId);
    if (!policy) throw new NotFoundException(`Permission policy not found: ${input.policyId}`);
    const now = new Date().toISOString();
    policy.enabled = false;
    policy.revokedAt = now;
    policy.note = input.note?.trim() || policy.note;
    queue.updatedAt = now;
    await this.writePermissionQueue(conversationId, queue);
    return { path: PERMISSIONS_PATH, policy };
  }

  private async ensurePermissionRequest(
    conversationId: string,
    input: { command: string; cwd: string; risk: TerminalCommandRisk },
  ): Promise<WorkspacePermissionRequest> {
    const queue = await this.loadPermissionQueue(conversationId);
    const existing = queue.requests.find(
      (request) =>
        request.status === 'pending' &&
        request.command === input.command &&
        request.cwd === input.cwd &&
        request.risk.level === input.risk.level,
    );
    if (existing) return existing;

    const now = new Date().toISOString();
    const request: WorkspacePermissionRequest = {
      id: `perm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      conversationId,
      command: input.command,
      cwd: input.cwd,
      risk: input.risk,
      status: 'pending',
      requestedAt: now,
    };
    queue.requests.push(request);
    queue.updatedAt = now;
    await this.writePermissionQueue(conversationId, queue);
    return request;
  }

  private async consumeApprovedPermission(
    conversationId: string,
    input: { command: string; cwd: string; risk: TerminalCommandRisk },
  ): Promise<WorkspacePermissionRequest | null> {
    const queue = await this.loadPermissionQueue(conversationId);
    const request = queue.requests.find(
      (item) =>
        item.status === 'approved' &&
        item.command === input.command &&
        item.cwd === input.cwd &&
        item.risk.level === input.risk.level,
    );
    if (!request) return null;
    request.status = 'used';
    request.usedAt = new Date().toISOString();
    queue.updatedAt = request.usedAt;
    await this.writePermissionQueue(conversationId, queue);
    return request;
  }

  private async matchPermissionPolicy(
    conversationId: string,
    input: { command: string; cwd: string; risk: TerminalCommandRisk },
  ): Promise<WorkspacePermissionPolicy | null> {
    const queue = await this.loadPermissionQueue(conversationId);
    return queue.policies.find((policy) => permissionPolicyMatches(policy, input)) ?? null;
  }

  async readMemoryContext(
    conversationId: string,
    input: { agentId?: string; agentName?: string; maxBytes?: number; query?: string; maxHighlights?: number } = {},
  ): Promise<MemoryContextResult> {
    const agentPath = agentMemoryPath(input.agentId ?? input.agentName);
    const maxBytes = clampInt(input.maxBytes ?? 12_000, 1_000, 80_000);
    const query = optionalNonEmptyString(input.query);
    const maxHighlights = clampInt(input.maxHighlights ?? 12, 1, 40);
    const entries = await Promise.all(
      [
        { scope: 'project' as const, path: 'PROJECT.md' },
        { scope: 'team' as const, path: 'TEAM_MEMORY.md' },
        { scope: 'agent' as const, path: agentPath },
        { scope: 'local' as const, path: LOCAL_MEMORY_PATH },
      ].map(async (item) => {
        const read = await this.readFile(conversationId, { path: item.path, maxBytes }).catch(() => null);
        return {
          scope: item.scope,
          path: item.path,
          content: read?.content ?? '',
          exists: Boolean(read),
          truncated: read?.truncated ?? false,
          highlights: query
            ? extractMemoryHighlights(item.scope, item.path, read?.content ?? '', query, Math.max(1, Math.ceil(maxHighlights / 4)))
            : undefined,
        };
      }),
    );
    const highlights = entries
      .flatMap((entry) => entry.highlights ?? [])
      .sort((a, b) => b.score - a.score)
      .slice(0, maxHighlights)
      .sort((a, b) => a.path.localeCompare(b.path) || a.lineStart - b.lineStart);
    return { entries, query, highlights };
  }

  async appendMemoryNote(
    conversationId: string,
    input: {
      scope: MemoryScope;
      note: string;
      title?: string;
      agentId?: string;
      agentName?: string;
    },
  ): Promise<MemoryUpdateResult> {
    const note = input.note.trim();
    if (!note) throw new BadRequestException('note is required');
    const filePath = memoryPathForScope(input.scope, input.agentId ?? input.agentName);
    const abs = this.resolveInside(conversationId, filePath);
    await mkdir(path.dirname(abs), { recursive: true });
    const stamp = new Date().toISOString();
    const title = input.title?.trim() || durableMemoryTitle(input.scope);
    const author = input.agentName?.trim() || input.agentId?.trim();
    const block = [
      '',
      `## ${title}`,
      '',
      `- time: ${stamp}`,
      author ? `- agent: ${author}` : undefined,
      `- note: ${note}`,
      '',
    ]
      .filter((line): line is string => typeof line === 'string')
      .join('\n');
    await appendFile(abs, block, 'utf8');
    const s = await stat(abs);
    return {
      scope: input.scope,
      path: filePath,
      size: s.size,
      mtime: s.mtime.toISOString(),
    };
  }

  async runCommand(
    conversationId: string,
    input: { command: string; cwd?: string; timeoutMs?: number },
  ): Promise<TerminalRunResult> {
    if (!input.command || !input.command.trim()) throw new Error('command is required');
    if (process.env.AGENTHUB_ENABLE_TERMINAL === 'false') {
      throw new Error('terminal_run is disabled by AGENTHUB_ENABLE_TERMINAL=false');
    }

    const cwd = await this.resolveTerminalCwd(conversationId, input.cwd);
    const risk = classifyTerminalCommand(input.command);
    if (risk.requiresConfirmation) {
      const policy = await this.matchPermissionPolicy(conversationId, {
        command: input.command,
        cwd,
        risk,
      });
      if (!policy) {
        const approval = await this.consumeApprovedPermission(conversationId, {
          command: input.command,
          cwd,
          risk,
        });
        if (!approval) {
        const request = await this.ensurePermissionRequest(conversationId, {
          command: input.command,
          cwd,
          risk,
        });
      throw new BadRequestException(
          `Command requires user confirmation before execution (${risk.level}): ${risk.reason}. Permission request: ${request.id}`,
      );
        }
      }
    }
    // Ceiling raised to 10 min: real `npm install` / `next build` in the
    // verification loop legitimately exceeds 2 min on a cold workspace.
    const timeoutMs = clampInt(input.timeoutMs ?? 20_000, 1_000, 600_000);
    const maxOutput = 32_000;
    const cwdMarker = `__AGENTHUB_CWD_${Date.now()}_${Math.random().toString(36).slice(2)}__=`;
    const exitMarker = `__AGENTHUB_EXIT_${Date.now()}_${Math.random().toString(36).slice(2)}__=`;
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const shellInvocation = createPowerShellInvocation(input.command, cwdMarker, exitMarker);

    return await new Promise<TerminalRunResult>((resolve) => {
      const child = spawn(shell === 'powershell' ? 'powershell.exe' : 'pwsh', shellInvocation, {
        cwd,
        shell: false,
        windowsHide: true,
        env: {
          ...process.env,
          AGENTHUB_WORKSPACE: cwd,
          PYTHONIOENCODING: 'utf-8',
          LANG: process.env.LANG ?? 'C.UTF-8',
          LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
        },
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;
      let finalCwd = cwd;
      let commandExitCode: number | null = null;

      const append = (target: 'stdout' | 'stderr', chunk: Buffer | string) => {
        const currentTotal = stdout.length + stderr.length;
        if (currentTotal >= maxOutput) {
          truncated = true;
          return;
        }
        const text = decodeTerminalChunk(chunk);
        const remaining = maxOutput - currentTotal;
        const next = text.length > remaining ? text.slice(0, remaining) : text;
        if (text.length > remaining) truncated = true;
        if (target === 'stdout') stdout += next;
        else stderr += next;
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
        child.kill();
      }, timeoutMs);

      child.stdout?.on('data', (chunk) => append('stdout', chunk));
      child.stderr?.on('data', (chunk) => append('stderr', chunk));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          command: input.command,
          risk,
          cwd: finalCwd,
          startedCwd: cwd,
          shell,
          exitCode: null,
          signal: null,
          timedOut,
          stdout,
          stderr: stderr + (stderr ? '\n' : '') + error.message,
          truncated,
        });
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const parsed = parseTerminalMarkers(stdout, cwdMarker, exitMarker);
        const root = this.getConversationRoot(conversationId);
        stdout = parsed.stdout;
        finalCwd = parsed.cwd ?? finalCwd;
        commandExitCode = parsed.exitCode ?? code;
        if (!isInside(root, finalCwd)) {
          stderr += `${stderr ? '\n' : ''}cwd escaped the project workspace; reset to workspace root`;
          finalCwd = root;
          commandExitCode = commandExitCode === 0 ? 1 : commandExitCode;
        }
        resolve({
          command: input.command,
          risk,
          cwd: finalCwd,
          startedCwd: cwd,
          shell,
          exitCode: commandExitCode,
          signal,
          timedOut,
          stdout,
          stderr,
          truncated,
        });
      });
    });
  }

  getToolSchemas(): ToolSchema[] {
    return WORKSPACE_TOOL_SCHEMAS;
  }

  async executeTool(conversationId: string, name: string, rawArgs: unknown): Promise<unknown> {
    const args = normalizeArgs(rawArgs);
    switch (name) {
      case 'workspace_list':
        return await this.listFiles(conversationId, {
          path: optionalString(args.path),
          maxFiles: optionalNumber(args.maxFiles),
        });
      case 'workspace_read':
        return await this.readFile(conversationId, {
          path: requiredString(args.path, 'path'),
          maxBytes: optionalNumber(args.maxBytes),
        });
      case 'workspace_read_many':
        return await this.readFiles(conversationId, {
          files: requiredReadFileArray(args.files, 'files'),
        });
      case 'workspace_write':
        return await this.writeFile(conversationId, {
          path: requiredString(args.path, 'path'),
          content: requiredString(args.content, 'content'),
        });
      case 'workspace_write_many':
        return await this.writeFiles(conversationId, {
          files: requiredWriteFileArray(args.files, 'files'),
        });
      case 'workspace_delete':
        return await this.deletePath(conversationId, {
          path: requiredString(args.path, 'path'),
          recursive: Boolean(args.recursive),
        });
      case 'task_board_list':
        return await this.readTaskBoard(conversationId);
      case 'task_board_update':
        return await this.updateTaskBoard(conversationId, {
          taskId: requiredString(args.taskId, 'taskId'),
          status: optionalTaskBoardStatus(args.status),
          owner: optionalString(args.owner),
          title: optionalString(args.title),
          details: optionalString(args.details),
          blocker: optionalString(args.blocker),
          handoff: optionalString(args.handoff),
          note: optionalString(args.note),
          artifactPath: optionalString(args.artifactPath),
        });
      case 'team_message_send':
        return await this.sendTeamMessage(conversationId, {
          to: requiredString(args.to, 'to'),
          subject: requiredString(args.subject, 'subject'),
          body: requiredString(args.body, 'body'),
          fromAgentId: optionalString(args.fromAgentId),
          fromAgentName: optionalString(args.fromAgentName),
          taskId: optionalString(args.taskId),
          priority: optionalTeamMessagePriority(args.priority),
        });
      case 'team_message_list':
        return await this.readTeamMailbox(conversationId, {
          recipient: optionalString(args.recipient),
          includeRead: optionalBoolean(args.includeRead),
          limit: optionalNumber(args.limit),
        });
      case 'team_message_mark_read':
        return await this.markTeamMessagesRead(conversationId, {
          ids: requiredStringArray(args.ids, 'ids'),
        });
      case 'team_wake_list':
        return await this.listTeamWakeQueue(conversationId, {
          target: optionalString(args.target),
          includeResolved: optionalBoolean(args.includeResolved),
          limit: optionalNumber(args.limit),
        });
      case 'team_wake_update':
        return await this.resolveTeamWake(conversationId, {
          wakeId: requiredString(args.wakeId, 'wakeId'),
          status: requiredTeamWakeToolStatus(args.status),
          agentId: optionalString(args.agentId),
          agentName: optionalString(args.agentName),
          note: optionalString(args.note),
        });
      case 'memory_context':
        return await this.readMemoryContext(conversationId, {
          agentId: optionalString(args.agentId),
          agentName: optionalString(args.agentName),
          maxBytes: optionalNumber(args.maxBytes),
          query: optionalString(args.query),
          maxHighlights: optionalNumber(args.maxHighlights),
        });
      case 'memory_note':
        return await this.appendMemoryNote(conversationId, {
          scope: requiredMemoryScope(args.scope),
          note: requiredString(args.note, 'note'),
          title: optionalString(args.title),
          agentId: optionalString(args.agentId),
          agentName: optionalString(args.agentName),
        });
      case 'terminal_run':
        return await this.runCommand(conversationId, {
          command: requiredString(args.command, 'command'),
          cwd: optionalString(args.cwd),
          timeoutMs: optionalNumber(args.timeoutMs),
        });
      default:
        throw new Error(`Unknown workspace tool: ${name}`);
    }
  }

  private resolveInside(conversationId: string, relativePath: string): string {
    const root = this.getConversationRoot(conversationId);
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (path.isAbsolute(relativePath) || normalized.split('/').includes('..')) {
      throw new Error(`Unsafe workspace path: ${relativePath}`);
    }
    const abs = path.resolve(root, normalized || '.');
    assertInside(root, abs);
    return abs;
  }

  private async resolveTerminalCwd(conversationId: string, cwd?: string): Promise<string> {
    const root = await this.ensureWorkspace(conversationId);
    if (!cwd || cwd.trim() === '') return root;

    const trimmed = cwd.trim();
    const abs = path.isAbsolute(trimmed)
      ? path.resolve(trimmed)
      : this.resolveInside(conversationId, trimmed);
    assertInside(root, abs);
    const s = await stat(abs).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) {
        throw new BadRequestException(`Terminal cwd not found: ${cwd}`);
      }
      throw error;
    });
    if (!s.isDirectory()) throw new BadRequestException(`Terminal cwd is not a directory: ${cwd}`);
    return abs;
  }
}

export interface WorkspaceFileEntry {
  path: string;
  type: 'file' | 'directory';
  size?: number;
  mtime: string;
}

export interface WorkspaceListResult {
  root: string;
  files: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceReadResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
  sha256: string;
}

export interface WorkspaceWriteResult {
  path: string;
  size: number;
  mtime: string;
}

export interface WorkspaceUploadResult {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'text' | 'file';
}

export interface WorkspaceBinaryReadResult {
  path: string;
  buffer: Buffer;
  size: number;
  sha256: string;
}

export interface WorkspaceBatchReadResult {
  count: number;
  files: Array<
    | { ok: true; value: WorkspaceReadResult }
    | { ok: false; path: string; error: string }
  >;
}

export interface WorkspaceBatchWriteResult {
  count: number;
  files: Array<
    | { ok: true; value: WorkspaceWriteResult }
    | { ok: false; path: string; error: string }
  >;
}

export interface WorkspaceDeleteResult {
  path: string;
  deleted: true;
}

export interface TerminalRunResult {
  command: string;
  risk: TerminalCommandRisk;
  cwd: string;
  startedCwd: string;
  shell: 'powershell' | 'pwsh';
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type TerminalCommandRiskLevel =
  | 'read_only'
  | 'normal_write'
  | 'network'
  | 'docker'
  | 'deployment'
  | 'credential_sensitive'
  | 'destructive';

export interface TerminalCommandRisk {
  level: TerminalCommandRiskLevel;
  requiresConfirmation: boolean;
  reason: string;
}

export type WorkspacePermissionStatus = 'pending' | 'approved' | 'denied' | 'used';
export type WorkspacePermissionPolicyScope = 'exact_command' | 'cwd_risk';

export interface WorkspacePermissionRequest {
  id: string;
  conversationId: string;
  command: string;
  cwd: string;
  risk: TerminalCommandRisk;
  status: WorkspacePermissionStatus;
  requestedAt: string;
  decidedAt?: string;
  decisionNote?: string;
  usedAt?: string;
  persistedPolicyId?: string;
  persistedScope?: WorkspacePermissionPolicyScope;
}

export interface WorkspacePermissionPolicy {
  id: string;
  conversationId: string;
  scope: WorkspacePermissionPolicyScope;
  command?: string;
  cwd: string;
  riskLevel: TerminalCommandRiskLevel;
  riskReason: string;
  enabled: boolean;
  note?: string;
  createdAt: string;
  createdFromRequestId?: string;
  revokedAt?: string;
}

export interface WorkspacePermissionQueue {
  version: 1;
  conversationId: string;
  updatedAt: string;
  requests: WorkspacePermissionRequest[];
  policies: WorkspacePermissionPolicy[];
}

export interface WorkspacePermissionListResult {
  path: string;
  requests: WorkspacePermissionRequest[];
  policies: WorkspacePermissionPolicy[];
}

export interface WorkspacePermissionDecisionResult {
  path: string;
  request: WorkspacePermissionRequest;
  policy?: WorkspacePermissionPolicy;
}

export interface WorkspacePermissionPolicyResult {
  path: string;
  policy: WorkspacePermissionPolicy;
}

export type TeamTaskBoardStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'blocked'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface TeamTaskBoardNote {
  text: string;
  createdAt: string;
}

export interface TeamTaskBoardItem {
  id: string;
  title: string;
  details?: string;
  status: TeamTaskBoardStatus;
  owner?: string;
  dependencies: string[];
  deliverables?: string[];
  checklist?: string[];
  acceptance?: string[];
  sourcePlanTaskId?: string;
  outputSummary?: string;
  blocker?: string;
  handoff?: string;
  artifactPaths?: string[];
  notes?: TeamTaskBoardNote[];
  updatedAt: string;
}

export interface TeamTaskBoard {
  version: 1;
  conversationId: string;
  updatedAt: string;
  tasks: TeamTaskBoardItem[];
}

export interface TaskBoardUpdateResult {
  path: string;
  board: TeamTaskBoard;
  task: TeamTaskBoardItem;
}

export type TeamMessagePriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TeamMailboxMessage {
  id: string;
  conversationId: string;
  fromAgentId?: string;
  fromAgentName: string;
  to: string;
  subject: string;
  body: string;
  taskId?: string;
  priority: TeamMessagePriority;
  createdAt: string;
  readAt?: string;
}

export interface TeamMailbox {
  version: 1;
  conversationId: string;
  updatedAt: string;
  messages: TeamMailboxMessage[];
}

export interface TeamMailboxListResult {
  path: string;
  messages: TeamMailboxMessage[];
}

export interface TeamMessageSendResult {
  path: string;
  message: TeamMailboxMessage;
}

export type TeamWakeStatus = 'pending' | 'claimed' | 'resolved' | 'cancelled' | 'failed';

export interface TeamWakeRequest {
  id: string;
  conversationId: string;
  messageId: string;
  target: string;
  subject: string;
  priority: TeamMessagePriority;
  taskId?: string;
  status: TeamWakeStatus;
  claimedByAgentId?: string;
  claimedByAgentName?: string;
  attempts?: number;
  maxAttempts?: number;
  nextRunAt?: string;
  lastError?: string;
  statusNote?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamWakeQueue {
  version: 1;
  conversationId: string;
  updatedAt: string;
  wakeups: TeamWakeRequest[];
}

export interface TeamWakeQueueListResult {
  path: string;
  wakeups: TeamWakeRequest[];
}

export interface TeamWakeQueueItemResult {
  path: string;
  wakeup: TeamWakeRequest;
}

export type MemoryScope = 'project' | 'team' | 'agent' | 'local';

export interface MemoryContextEntry {
  scope: MemoryScope;
  path: string;
  content: string;
  exists: boolean;
  truncated: boolean;
  highlights?: MemoryContextHighlight[];
}

export interface MemoryContextHighlight {
  scope: MemoryScope;
  path: string;
  lineStart: number;
  lineEnd: number;
  score: number;
  text: string;
}

export interface MemoryContextResult {
  entries: MemoryContextEntry[];
  query?: string;
  highlights?: MemoryContextHighlight[];
}

export interface MemoryUpdateResult {
  scope: MemoryScope;
  path: string;
  size: number;
  mtime: string;
}

const WORKSPACE_TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'workspace_list',
    description: 'List files and directories in the current conversation workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory or file path. Defaults to workspace root.' },
        maxFiles: { type: 'number', description: 'Maximum entries to return. Default 300, max 1000.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read',
    description: 'Read a UTF-8 text file from the current conversation workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to read.' },
        maxBytes: { type: 'number', description: 'Maximum bytes to read. Default 200000.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_read_many',
    description: 'Read multiple UTF-8 text files from the current conversation workspace in one tool call. Prefer this over repeated workspace_read calls.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to read. Maximum 20 items per call.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path to read.' },
              maxBytes: { type: 'number', description: 'Maximum bytes to read for this file.' },
            },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write',
    description: 'Create or overwrite a UTF-8 text file in the current conversation workspace. Parent directories are created automatically.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path to write.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_write_many',
    description: 'Create or overwrite multiple UTF-8 text files in one tool call. Use this for project generation instead of calling workspace_write once per file.',
    parameters: {
      type: 'object',
      properties: {
        files: {
          type: 'array',
          description: 'Files to write. Maximum 30 items per call.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Relative file path to write.' },
              content: { type: 'string', description: 'Full file content.' },
            },
            required: ['path', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['files'],
      additionalProperties: false,
    },
  },
  {
    name: 'workspace_delete',
    description: 'Delete a file or directory in the current conversation workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file or directory path to delete.' },
        recursive: { type: 'boolean', description: 'Required for deleting directories.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'task_board_list',
    description: 'Read the shared team task board for this conversation. Use it before multi-agent work to see owners, blockers, handoffs, dependencies, and produced artifacts.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'task_board_update',
    description: 'Update the shared team task board with your current status, blocker, handoff note, or artifact path so other agents can coordinate with your work.',
    parameters: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task id from task_board_list or the current plan task id.' },
        status: {
          type: 'string',
          enum: ['pending', 'ready', 'running', 'blocked', 'done', 'failed', 'cancelled'],
          description: 'Current task status.',
        },
        owner: { type: 'string', description: 'Agent id/name responsible for this task.' },
        title: { type: 'string', description: 'Short task title when creating an ad-hoc task.' },
        details: { type: 'string', description: 'Useful context for another agent.' },
        blocker: { type: 'string', description: 'Concrete blocker, failed command, missing credential, or user decision.' },
        handoff: { type: 'string', description: 'What another agent should know before picking up related work.' },
        note: { type: 'string', description: 'Append a timestamped coordination note.' },
        artifactPath: { type: 'string', description: 'Workspace path to a produced file or artifact.' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_message_send',
    description: 'Send a directed mailbox message to another teammate by name or role. Use this for handoffs, API contract changes, blockers, and work that another agent must see.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient teammate name, role, or "team" for broadcast.' },
        subject: { type: 'string', description: 'Short subject.' },
        body: { type: 'string', description: 'Concrete message body with files, commands, blockers, or decisions.' },
        taskId: { type: 'string', description: 'Related plan/task-board id when available.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Message priority.' },
      },
      required: ['to', 'subject', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_message_list',
    description: 'Read directed mailbox messages for the current agent or a named recipient. Use before starting work so teammate handoffs are not missed.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string', description: 'Recipient name/id. Defaults to the current agent when omitted.' },
        includeRead: { type: 'boolean', description: 'Include already-read messages.' },
        limit: { type: 'number', description: 'Maximum messages to return. Default 50, max 200.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'team_message_mark_read',
    description: 'Mark directed mailbox messages as read after consuming a handoff.',
    parameters: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Message ids to mark read.',
        },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
  {
    name: 'team_wake_list',
    description: 'Read pending teammate wake requests created from directed messages. This is the scheduler-facing queue for waking or claiming idle teammate work.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target teammate/role. Defaults to all pending wake requests.' },
        includeResolved: { type: 'boolean', description: 'Include claimed/resolved/cancelled wake requests.' },
        limit: { type: 'number', description: 'Maximum wake requests to return. Default 50, max 200.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'team_wake_update',
    description: 'Claim, resolve, or cancel a teammate wake request after consuming the corresponding directed message.',
    parameters: {
      type: 'object',
      properties: {
        wakeId: { type: 'string', description: 'Wake request id from team_wake_list.' },
        status: { type: 'string', enum: ['pending', 'claimed', 'resolved', 'cancelled', 'failed'], description: 'New wake request status. Use pending to requeue.' },
        agentId: { type: 'string', description: 'Current agent id. Defaults to injected runtime metadata.' },
        agentName: { type: 'string', description: 'Current agent name. Defaults to injected runtime metadata.' },
        note: { type: 'string', description: 'Optional reason for the status change.' },
      },
      required: ['wakeId', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_context',
    description: 'Read layered memory for the project, team, current agent, and local machine caveats. Use before substantial implementation or debugging.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Current agent id. Defaults to injected runtime metadata.' },
        agentName: { type: 'string', description: 'Current agent name. Defaults to injected runtime metadata.' },
        maxBytes: { type: 'number', description: 'Maximum bytes per memory file.' },
        query: { type: 'string', description: 'Current task, blocker, or decision to rank relevant memory snippets.' },
        maxHighlights: { type: 'number', description: 'Maximum highlighted snippets returned across memory layers. Default 12.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_note',
    description: 'Append a durable memory note. Only use for stable product decisions, shared contracts, environment setup, repeated role learnings, or local setup caveats.',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'team', 'agent', 'local'], description: 'Memory layer to update.' },
        title: { type: 'string', description: 'Short memory section title.' },
        note: { type: 'string', description: 'Durable fact to remember.' },
        agentId: { type: 'string', description: 'Current agent id for agent memory.' },
        agentName: { type: 'string', description: 'Current agent name for agent memory.' },
      },
      required: ['scope', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'terminal_run',
    description: 'Run a PowerShell command in the current conversation workspace and return stdout, stderr, exit code, final cwd, and command risk classification. Destructive, deployment, and credential-sensitive commands are blocked until the user confirms them.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to run.' },
        cwd: { type: 'string', description: 'Current working directory. Defaults to the workspace root. Must stay inside the workspace.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 20000, max 600000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

/**
 * Kill the WHOLE process tree of a spawned terminal command. Agents like to
 * start dev/servers ("node server.js", "npm run start") which keep running
 * after our top-level `child.kill()` — on Windows the npm→node grandchildren
 * survive, pile up, hold ports/handles and eventually starve the server (the
 * workspace file-list endpoint then "Failed to fetch"). taskkill /T reaps the
 * entire tree. Best-effort, never throws.
 */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {
    /* process already gone — fine */
  }
}

function sanitizeConversationId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120);
  return safe || 'default';
}

function sanitizeFilename(name: string): string {
  const basename = path.basename(name || 'attachment');
  const safe = basename.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
  return safe || 'attachment';
}

function decodeBase64Payload(payload: string): Buffer {
  const raw = payload.includes(',') ? payload.slice(payload.indexOf(',') + 1) : payload;
  if (!/^[a-zA-Z0-9+/=\r\n]+$/.test(raw)) {
    throw new BadRequestException('Invalid base64 payload');
  }
  return Buffer.from(raw, 'base64');
}

function attachmentKind(mimeType: string, name: string): 'image' | 'text' | 'file' {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || /\.(md|txt|json|csv|ts|tsx|js|jsx|css|html|xml|yaml|yml)$/i.test(name)) {
    return 'text';
  }
  return 'file';
}

function assertInside(root: string, target: string): void {
  if (!isInside(root, target)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function shouldIgnore(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === '.next' || name === 'dist' || name === '.turbo';
}

function decodeTerminalChunk(chunk: Buffer | string): string {
  if (typeof chunk === 'string') return chunk;

  const utf8 = chunk.toString('utf8');
  if (!looksGarbled(utf8)) return utf8;

  try {
    return new TextDecoder('gb18030').decode(chunk);
  } catch {
    return utf8;
  }
}

function looksGarbled(text: string): boolean {
  return text.includes('\uFFFD') || text.includes('\u951f\u65a4\u62f7') || /[\u00C3\u00C2][\x80-\xBF]?/.test(text);
}

function createPowerShellInvocation(command: string, cwdMarker: string, exitMarker: string): string[] {
  const script = [
    'try { chcp.com 65001 > $null } catch {}',
    "[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$env:PYTHONIOENCODING = 'utf-8'",
    "$env:LANG = 'C.UTF-8'",
    "$env:LC_ALL = 'C.UTF-8'",
    "$__agenthubExitCode = 0",
    'try {',
    '  $__agenthubOutput = & {',
    command,
    '  } 2>&1',
    '  $__agenthubSucceeded = $?',
    '  if ($null -ne $__agenthubOutput) {',
    '    $__agenthubOutput | Out-String -Width 2000 | Write-Output',
    '  }',
    '  if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) {',
    '    $__agenthubExitCode = [int]$global:LASTEXITCODE',
    '  } elseif (-not $__agenthubSucceeded) {',
    '    $__agenthubExitCode = 1',
    '  }',
    '} catch {',
    '  Write-Error $_',
    '  $__agenthubExitCode = 1',
    '}',
    `Write-Output "${exitMarker}$__agenthubExitCode"`,
    `Write-Output "${cwdMarker}$((Get-Location).ProviderPath)"`,
    'exit $__agenthubExitCode',
  ].join('\n');

  return ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

function parseTerminalMarkers(
  stdout: string,
  cwdMarker: string,
  exitMarker: string,
): { stdout: string; cwd?: string; exitCode?: number } {
  let cwd: string | undefined;
  let exitCode: number | undefined;
  const lines = stdout.split(/\r?\n/);
  const visible: string[] = [];

  for (const line of lines) {
    if (line.startsWith(cwdMarker)) {
      cwd = line.slice(cwdMarker.length).trim();
      continue;
    }
    if (line.startsWith(exitMarker)) {
      const parsed = Number(line.slice(exitMarker.length).trim());
      if (Number.isFinite(parsed)) exitCode = parsed;
      continue;
    }
    visible.push(line);
  }

  return { stdout: normalizeTerminalOutput(visible.join('\n')), cwd, exitCode };
}

function normalizeTerminalOutput(output: string): string {
  const lines = output
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));

  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();

  const normalized: string[] = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankCount += 1;
      if (blankCount <= 1) normalized.push('');
      continue;
    }
    blankCount = 0;
    normalized.push(line);
  }

  return normalized.join('\n');
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function normalizeArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalTaskBoardStatus(value: unknown): TeamTaskBoardStatus | undefined {
  if (typeof value !== 'string') return undefined;
  if (
    value === 'pending' ||
    value === 'ready' ||
    value === 'running' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'cancelled'
  ) {
    return value;
  }
  throw new Error(`Unsupported task board status: ${value}`);
}

function optionalTeamMessagePriority(value: unknown): TeamMessagePriority | undefined {
  if (typeof value !== 'string') return undefined;
  if (value === 'low' || value === 'normal' || value === 'high' || value === 'urgent') {
    return value;
  }
  throw new Error(`Unsupported team message priority: ${value}`);
}

function requiredTeamWakeToolStatus(value: unknown): TeamWakeStatus {
  if (value === 'pending' || value === 'claimed' || value === 'resolved' || value === 'cancelled' || value === 'failed') {
    return value;
  }
  throw new Error('status must be one of pending, claimed, resolved, cancelled, failed');
}

function requiredMemoryScope(value: unknown): MemoryScope {
  if (value === 'project' || value === 'team' || value === 'agent' || value === 'local') return value;
  throw new Error('scope must be one of project, team, agent, local');
}

function requiredStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => requiredString(item, `${name}[${index}]`));
}

function createEmptyTeamMailbox(conversationId: string): TeamMailbox {
  const now = new Date().toISOString();
  return {
    version: 1,
    conversationId,
    updatedAt: now,
    messages: [],
  };
}

function normalizeTeamMailbox(raw: unknown, conversationId: string): TeamMailbox {
  if (!raw || typeof raw !== 'object') return createEmptyTeamMailbox(conversationId);
  const row = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const messages = Array.isArray(row.messages)
    ? row.messages.flatMap((message) => normalizeTeamMailboxMessage(message, conversationId))
    : [];
  return {
    version: 1,
    conversationId,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    messages,
  };
}

function normalizeTeamMailboxMessage(raw: unknown, conversationId: string): TeamMailboxMessage[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  const id = optionalNonEmptyString(row.id);
  const to = optionalNonEmptyString(row.to);
  const subject = optionalNonEmptyString(row.subject);
  const body = optionalNonEmptyString(row.body);
  if (!id || !to || !subject || !body) return [];
  return [
    {
      id,
      conversationId,
      fromAgentId: optionalNonEmptyString(row.fromAgentId),
      fromAgentName: optionalNonEmptyString(row.fromAgentName) ?? 'agent',
      to,
      subject,
      body,
      taskId: optionalNonEmptyString(row.taskId),
      priority: optionalTeamMessagePriority(row.priority) ?? 'normal',
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      readAt: optionalNonEmptyString(row.readAt),
    },
  ];
}

function createEmptyTeamWakeQueue(conversationId: string): TeamWakeQueue {
  const now = new Date().toISOString();
  return {
    version: 1,
    conversationId,
    updatedAt: now,
    wakeups: [],
  };
}

function normalizeTeamWakeQueue(raw: unknown, conversationId: string): TeamWakeQueue {
  if (!raw || typeof raw !== 'object') return createEmptyTeamWakeQueue(conversationId);
  const row = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const wakeups = Array.isArray(row.wakeups)
    ? row.wakeups.flatMap((item) => normalizeTeamWakeRequest(item, conversationId))
    : [];
  return {
    version: 1,
    conversationId,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    wakeups,
  };
}

function normalizeTeamWakeRequest(raw: unknown, conversationId: string): TeamWakeRequest[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  const id = optionalNonEmptyString(row.id);
  const messageId = optionalNonEmptyString(row.messageId);
  const target = optionalNonEmptyString(row.target);
  const subject = optionalNonEmptyString(row.subject);
  const status = normalizeTeamWakeStatus(row.status);
  if (!id || !messageId || !target || !subject || !status) return [];
  return [
    {
      id,
      conversationId,
      messageId,
      target,
      subject,
      priority: optionalTeamMessagePriority(row.priority) ?? 'normal',
      taskId: optionalNonEmptyString(row.taskId),
      status,
      claimedByAgentId: optionalNonEmptyString(row.claimedByAgentId),
      claimedByAgentName: optionalNonEmptyString(row.claimedByAgentName),
      attempts: optionalFiniteNumber(row.attempts),
      maxAttempts: optionalFiniteNumber(row.maxAttempts),
      nextRunAt: optionalNonEmptyString(row.nextRunAt),
      lastError: optionalNonEmptyString(row.lastError),
      statusNote: optionalNonEmptyString(row.statusNote),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : new Date().toISOString(),
    },
  ];
}

function normalizeTeamWakeStatus(value: unknown): TeamWakeStatus | undefined {
  if (value === 'pending' || value === 'claimed' || value === 'resolved' || value === 'cancelled' || value === 'failed') return value;
  return undefined;
}

function createEmptyPermissionQueue(conversationId: string): WorkspacePermissionQueue {
  const now = new Date().toISOString();
  return {
    version: 1,
    conversationId,
    updatedAt: now,
    requests: [],
    policies: [],
  };
}

function normalizePermissionQueue(raw: unknown, conversationId: string): WorkspacePermissionQueue {
  if (!raw || typeof raw !== 'object') return createEmptyPermissionQueue(conversationId);
  const row = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const requests = Array.isArray(row.requests)
    ? row.requests.flatMap((item) => normalizePermissionRequest(item, conversationId))
    : [];
  const policies = Array.isArray(row.policies)
    ? row.policies.flatMap((item) => normalizePermissionPolicy(item, conversationId))
    : [];
  return {
    version: 1,
    conversationId,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    requests,
    policies,
  };
}

function normalizePermissionRequest(raw: unknown, conversationId: string): WorkspacePermissionRequest[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  const id = optionalNonEmptyString(row.id);
  const command = optionalNonEmptyString(row.command);
  const cwd = optionalNonEmptyString(row.cwd);
  const risk = normalizeTerminalRisk(row.risk);
  const status = normalizePermissionStatus(row.status);
  if (!id || !command || !cwd || !risk || !status) return [];
  return [
    {
      id,
      conversationId,
      command,
      cwd,
      risk,
      status,
      requestedAt: typeof row.requestedAt === 'string' ? row.requestedAt : new Date().toISOString(),
      decidedAt: optionalNonEmptyString(row.decidedAt),
      decisionNote: optionalNonEmptyString(row.decisionNote),
      usedAt: optionalNonEmptyString(row.usedAt),
      persistedPolicyId: optionalNonEmptyString(row.persistedPolicyId),
      persistedScope: normalizePermissionPolicyScope(row.persistedScope),
    },
  ];
}

function normalizePermissionPolicy(raw: unknown, conversationId: string): WorkspacePermissionPolicy[] {
  if (!raw || typeof raw !== 'object') return [];
  const row = raw as Record<string, unknown>;
  const id = optionalNonEmptyString(row.id);
  const scope = normalizePermissionPolicyScope(row.scope);
  const cwd = optionalNonEmptyString(row.cwd);
  const riskLevel = normalizeTerminalRiskLevel(row.riskLevel);
  const riskReason = optionalNonEmptyString(row.riskReason);
  if (!id || !scope || !cwd || !riskLevel || !riskReason) return [];
  const command = optionalNonEmptyString(row.command);
  if (scope === 'exact_command' && !command) return [];
  return [
    {
      id,
      conversationId,
      scope,
      command,
      cwd,
      riskLevel,
      riskReason,
      enabled: row.enabled !== false,
      note: optionalNonEmptyString(row.note),
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      createdFromRequestId: optionalNonEmptyString(row.createdFromRequestId),
      revokedAt: optionalNonEmptyString(row.revokedAt),
    },
  ];
}

function normalizePermissionPolicyScope(value: unknown): WorkspacePermissionPolicyScope | undefined {
  if (value === 'exact_command' || value === 'cwd_risk') return value;
  return undefined;
}

function createPermissionPolicy(
  conversationId: string,
  request: WorkspacePermissionRequest,
  scope: WorkspacePermissionPolicyScope,
  note: string | undefined,
): WorkspacePermissionPolicy {
  if (scope === 'cwd_risk' && !canPersistRiskForCwd(request.risk.level)) {
    throw new BadRequestException(`Risk level cannot be persisted for the whole cwd: ${request.risk.level}`);
  }
  return {
    id: `policy_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    conversationId,
    scope,
    command: scope === 'exact_command' ? request.command : undefined,
    cwd: request.cwd,
    riskLevel: request.risk.level,
    riskReason: request.risk.reason,
    enabled: true,
    note: note?.trim() || undefined,
    createdAt: new Date().toISOString(),
    createdFromRequestId: request.id,
  };
}

function permissionPolicyMatches(
  policy: WorkspacePermissionPolicy,
  input: { command: string; cwd: string; risk: TerminalCommandRisk },
): boolean {
  if (!policy.enabled) return false;
  if (policy.riskLevel !== input.risk.level) return false;
  if (policy.cwd !== input.cwd) return false;
  if (policy.scope === 'exact_command') return policy.command === input.command;
  return policy.scope === 'cwd_risk' && canPersistRiskForCwd(input.risk.level);
}

function canPersistRiskForCwd(level: TerminalCommandRiskLevel): boolean {
  return level !== 'destructive' && level !== 'credential_sensitive';
}

function normalizePermissionStatus(value: unknown): WorkspacePermissionStatus | undefined {
  if (value === 'pending' || value === 'approved' || value === 'denied' || value === 'used') return value;
  return undefined;
}

function normalizeTerminalRisk(raw: unknown): TerminalCommandRisk | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const level = normalizeTerminalRiskLevel(row.level);
  const reason = optionalNonEmptyString(row.reason);
  if (!level || !reason) return undefined;
  return {
    level,
    reason,
    requiresConfirmation: row.requiresConfirmation === true,
  };
}

function normalizeTerminalRiskLevel(value: unknown): TerminalCommandRiskLevel | undefined {
  if (
    value === 'read_only' ||
    value === 'normal_write' ||
    value === 'network' ||
    value === 'docker' ||
    value === 'deployment' ||
    value === 'credential_sensitive' ||
    value === 'destructive'
  ) {
    return value;
  }
  return undefined;
}

function agentMemoryPath(agent: string | undefined): string {
  const key = sanitizeMemoryKey(agent ?? 'agent');
  return `${AGENT_MEMORY_DIR}/${key}.md`;
}

function memoryPathForScope(scope: MemoryScope, agent: string | undefined): string {
  switch (scope) {
    case 'project':
      return 'PROJECT.md';
    case 'team':
      return 'TEAM_MEMORY.md';
    case 'agent':
      return agentMemoryPath(agent);
    case 'local':
      return LOCAL_MEMORY_PATH;
  }
}

function durableMemoryTitle(scope: MemoryScope): string {
  switch (scope) {
    case 'project':
      return 'Project Decision';
    case 'team':
      return 'Team Handoff';
    case 'agent':
      return 'Agent Learning';
    case 'local':
      return 'Local Setup Caveat';
  }
}

function extractMemoryHighlights(
  scope: MemoryScope,
  filePath: string,
  content: string,
  query: string,
  maxHighlights: number,
): MemoryContextHighlight[] {
  const tokens = memoryQueryTokens(query);
  if (!content.trim() || tokens.length === 0) return [];

  const lines = content.split(/\r?\n/);
  const windows = new Set<string>();
  const candidates: MemoryContextHighlight[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    const normalized = line.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!normalized.includes(token)) continue;
      score += token.length >= 6 ? 3 : 2;
    }
    if (score === 0) continue;
    if (/^#{1,4}\s+/.test(line.trim())) score += 2;

    const start = Math.max(0, index - 1);
    const end = Math.min(lines.length - 1, index + 1);
    const key = `${start}:${end}`;
    if (windows.has(key)) continue;
    windows.add(key);

    candidates.push({
      scope,
      path: filePath,
      lineStart: start + 1,
      lineEnd: end + 1,
      score,
      text: lines.slice(start, end + 1).join('\n').trim(),
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score || a.lineStart - b.lineStart)
    .slice(0, maxHighlights);
}

function memoryQueryTokens(query: string): string[] {
  const lower = query.toLowerCase();
  const ascii = lower.match(/[a-z0-9_.:\\/-]{2,}/g) ?? [];
  const cjk = lower.match(/[\u3400-\u9fff]{2,}/g) ?? [];
  const tokens = [...ascii, ...cjk]
    .map((token) => token.replace(/^[-_.:/\\]+|[-_.:/\\]+$/g, ''))
    .filter((token) => token.length >= 2);
  return [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, 40);
}

function sanitizeMemoryKey(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return safe || 'agent';
}

function isBroadcastWakeTarget(target: string): boolean {
  const normalized = target.trim().toLowerCase().replace(/^@+/, '');
  return normalized === 'team' || normalized === 'all' || normalized === '*';
}

function sortTeamWakeRequests(left: TeamWakeRequest, right: TeamWakeRequest): number {
  const leftStatus = teamWakeStatusRank(left.status);
  const rightStatus = teamWakeStatusRank(right.status);
  if (leftStatus !== rightStatus) return leftStatus - rightStatus;

  const leftNextRun = nextRunRank(left.nextRunAt);
  const rightNextRun = nextRunRank(right.nextRunAt);
  if (leftNextRun !== rightNextRun) return leftNextRun - rightNextRun;

  const leftPriority = teamWakePriorityRank(left.priority);
  const rightPriority = teamWakePriorityRank(right.priority);
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  return left.createdAt.localeCompare(right.createdAt);
}

function teamWakeStatusRank(status: TeamWakeStatus): number {
  if (status === 'pending') return 0;
  if (status === 'claimed') return 1;
  if (status === 'failed') return 2;
  if (status === 'cancelled') return 3;
  return 4;
}

function nextRunRank(nextRunAt: string | undefined): number {
  if (!nextRunAt) return 0;
  const timestamp = Date.parse(nextRunAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function teamWakePriorityRank(priority: TeamMessagePriority): number {
  if (priority === 'urgent') return 0;
  if (priority === 'high') return 1;
  if (priority === 'normal') return 2;
  return 3;
}

function wakeRetryDelayMs(attempts: number): number {
  return Math.min(60_000, 5_000 * Math.max(1, attempts));
}

function classifyTerminalCommand(command: string): TerminalCommandRisk {
  const normalized = command.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (
    /\brm\s+-rf\b/.test(lower) ||
    /\bremove-item\b/.test(lower) && /\b-recurse\b/.test(lower) ||
    /\brmdir\s+\/s\b/.test(lower) ||
    /\bdel\s+\/s\b/.test(lower) ||
    /\bformat\b/.test(lower) ||
    /\bshutdown\b/.test(lower) ||
    /\brestart-computer\b/.test(lower) ||
    /\bstop-computer\b/.test(lower) ||
    /\bgit\s+reset\s+--hard\b/.test(lower) ||
    /\bgit\s+clean\s+-f/.test(lower) ||
    /\bdocker\s+system\s+prune\b/.test(lower) ||
    /\bdocker\s+compose\s+down\b.*\s-v\b/.test(lower)
  ) {
    return {
      level: 'destructive',
      requiresConfirmation: true,
      reason: 'destructive filesystem, git, Docker, or host operation',
    };
  }

  if (
    /\bgit\s+push\b/.test(lower) ||
    /\bnpm\s+publish\b/.test(lower) ||
    /\bpnpm\s+publish\b/.test(lower) ||
    /\byarn\s+npm\s+publish\b/.test(lower) ||
    /\bvercel\b.*\b--prod\b/.test(lower) ||
    /\bwrangler\s+deploy\b/.test(lower) ||
    /\bsupabase\b.*\bdeploy\b/.test(lower) ||
    /\beas\s+submit\b/.test(lower)
  ) {
    return {
      level: 'deployment',
      requiresConfirmation: true,
      reason: 'publishing, deployment, or remote repository mutation',
    };
  }

  if (
    /(^|[\s;|&])(cat|type|get-content)\s+\.env(\s|$)/.test(lower) ||
    /\bget-childitem\s+env:/.test(lower) ||
    /\bprintenv\b/.test(lower) ||
    /\bsetx\b/.test(lower)
  ) {
    return {
      level: 'credential_sensitive',
      requiresConfirmation: true,
      reason: 'command may expose or mutate credentials/secrets',
    };
  }

  if (/\bdocker\b/.test(lower)) {
    return {
      level: 'docker',
      requiresConfirmation: false,
      reason: lower.includes('compose config')
        ? 'Docker diagnostic/config validation'
        : 'Docker command; daemon availability and side effects depend on host setup',
    };
  }

  if (
    /\b(npm|pnpm|yarn)\s+(install|add|dlx|create)\b/.test(lower) ||
    /\b(npx|uvx|pip|pip3|cargo)\s+/.test(lower) ||
    /\bgit\s+(clone|fetch|pull|ls-remote)\b/.test(lower) ||
    /\b(invoke-webrequest|invoke-restmethod|curl|wget)\b/.test(lower)
  ) {
    return {
      level: 'network',
      requiresConfirmation: false,
      reason: 'command may access network or download dependencies',
    };
  }

  if (
    /^(dir|ls|get-childitem|pwd|echo|type|cat|get-content)\b/.test(lower) ||
    /\b(tsc\s+--noemit|node\s+--check|npm\s+run\s+(typecheck|lint|build|test)|pnpm\s+(typecheck|lint|build|test))\b/.test(lower)
  ) {
    return {
      level: 'read_only',
      requiresConfirmation: false,
      reason: 'inspection or verification command',
    };
  }

  return {
    level: 'normal_write',
    requiresConfirmation: false,
    reason: 'normal workspace command; cwd is constrained to the conversation workspace',
  };
}

function createEmptyTaskBoard(conversationId: string): TeamTaskBoard {
  const now = new Date().toISOString();
  return {
    version: 1,
    conversationId,
    updatedAt: now,
    tasks: [],
  };
}

function normalizeTaskBoard(raw: unknown, conversationId: string): TeamTaskBoard {
  if (!raw || typeof raw !== 'object') return createEmptyTaskBoard(conversationId);
  const row = raw as Record<string, unknown>;
  const now = new Date().toISOString();
  const tasks = Array.isArray(row.tasks)
    ? row.tasks.map((item, index) => normalizeTaskBoardItem(item, `task-${index + 1}`, now))
    : [];
  return {
    version: 1,
    conversationId,
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
    tasks,
  };
}

function normalizeTaskBoardItem(raw: unknown, fallbackId: string, now: string): TeamTaskBoardItem {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : fallbackId;
  const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : id;
  return {
    id,
    title,
    details: optionalNonEmptyString(row.details),
    status: optionalTaskBoardStatus(row.status) ?? 'pending',
    owner: optionalNonEmptyString(row.owner),
    dependencies: stringArray(row.dependencies),
    deliverables: optionalStringArray(row.deliverables),
    checklist: optionalStringArray(row.checklist),
    acceptance: optionalStringArray(row.acceptance),
    sourcePlanTaskId: optionalNonEmptyString(row.sourcePlanTaskId),
    outputSummary: optionalNonEmptyString(row.outputSummary),
    blocker: optionalNonEmptyString(row.blocker),
    handoff: optionalNonEmptyString(row.handoff),
    artifactPaths: optionalStringArray(row.artifactPaths),
    notes: normalizeTaskBoardNotes(row.notes),
    updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now,
  };
}

function taskBoardItemFromPlanTask(
  task: PlanTask,
  existing: TeamTaskBoardItem | undefined,
  now: string,
): TeamTaskBoardItem {
  return {
    id: task.id,
    title: task.goal,
    details: task.details,
    status: taskBoardStatusFromPlanStatus(task.status),
    owner: task.assigneeAgentId,
    dependencies: task.inputs,
    deliverables: task.deliverables,
    checklist: task.checklist,
    acceptance: task.acceptance.map(acceptanceRuleLabel),
    sourcePlanTaskId: task.id,
    outputSummary: summarizeOutput(task.outputText),
    blocker: task.error?.message ?? existing?.blocker,
    handoff: existing?.handoff,
    artifactPaths: existing?.artifactPaths,
    notes: existing?.notes,
    updatedAt: now,
  };
}

function taskBoardStatusFromPlanStatus(status: TaskStatus): TeamTaskBoardStatus {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'ready':
      return 'ready';
    case 'running':
    case 'awaiting-critic':
      return 'running';
    case 'succeeded':
      return 'done';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
  }
}

function acceptanceRuleLabel(rule: PlanTask['acceptance'][number]): string {
  switch (rule.kind) {
    case 'test':
      return `test: ${rule.cmd}`;
    case 'critic-llm':
      return `critic: ${rule.rubric}`;
    default:
      return rule.kind;
  }
}

function summarizeOutput(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const prose = value.replace(/```[\s\S]*?```/g, ' [code written in workspace] ').replace(/\s+/g, ' ').trim();
  return prose.length > 500 ? `${prose.slice(0, 500)}...` : prose || undefined;
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = stringArray(value);
  return items.length > 0 ? items : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim());
}

function normalizeTaskBoardNotes(value: unknown): TeamTaskBoardNote[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const notes = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const text = optionalNonEmptyString(row.text);
    if (!text) return [];
    return [
      {
        text,
        createdAt: typeof row.createdAt === 'string' ? row.createdAt : new Date().toISOString(),
      },
    ];
  });
  return notes.length > 0 ? notes.slice(-30) : undefined;
}

function requiredReadFileArray(value: unknown, name: string): Array<{ path: string; maxBytes?: number }> {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${name}[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    const path = requiredString(row.path, `${name}[${index}].path`);
    return {
      path,
      maxBytes: optionalNumber(row.maxBytes),
    };
  });
}

function requiredWriteFileArray(value: unknown, name: string): Array<{ path: string; content: string }> {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  return value.map((item, index) => {
    if (!item || typeof item !== 'object') throw new Error(`${name}[${index}] must be an object`);
    const row = item as Record<string, unknown>;
    return {
      path: requiredString(row.path, `${name}[${index}].path`),
      content: requiredString(row.content, `${name}[${index}].content`),
    };
  });
}
