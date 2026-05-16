import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolSchema } from '@agenthub/adapter-core';

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

  async runCommand(
    conversationId: string,
    input: { command: string; cwd?: string; timeoutMs?: number },
  ): Promise<TerminalRunResult> {
    if (!input.command || !input.command.trim()) throw new Error('command is required');
    if (process.env.AGENTHUB_ENABLE_TERMINAL === 'false') {
      throw new Error('terminal_run is disabled by AGENTHUB_ENABLE_TERMINAL=false');
    }

    const cwd = await this.resolveTerminalCwd(conversationId, input.cwd);
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
        env: { ...process.env, AGENTHUB_WORKSPACE: cwd },
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
        const text = chunk.toString();
        const remaining = maxOutput - currentTotal;
        const next = text.length > remaining ? text.slice(0, remaining) : text;
        if (text.length > remaining) truncated = true;
        if (target === 'stdout') stdout += next;
        else stderr += next;
      };

      const timer = setTimeout(() => {
        timedOut = true;
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
    name: 'terminal_run',
    description: 'Run a PowerShell command in the current conversation workspace and return stdout, stderr, exit code, and final cwd.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'PowerShell command to run.' },
        cwd: { type: 'string', description: 'Current working directory. Defaults to the workspace root. Must stay inside the workspace.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 20000, max 120000.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
];

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

function createPowerShellInvocation(command: string, cwdMarker: string, exitMarker: string): string[] {
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
    "$OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
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
