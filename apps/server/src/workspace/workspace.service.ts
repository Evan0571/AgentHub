import { Injectable } from '@nestjs/common';
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
    const s = await stat(abs);
    if (!s.isFile()) throw new Error(`Not a file: ${input.path}`);

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
    const s = await stat(abs);
    if (s.isDirectory()) {
      if (!input.recursive) throw new Error('Directory delete requires recursive=true');
      await rm(abs, { recursive: true, force: true });
    } else {
      await unlink(abs);
    }
    return { path: input.path, deleted: true };
  }

  async runCommand(conversationId: string, input: { command: string; timeoutMs?: number }): Promise<TerminalRunResult> {
    if (!input.command || !input.command.trim()) throw new Error('command is required');
    if (process.env.AGENTHUB_ENABLE_TERMINAL === 'false') {
      throw new Error('terminal_run is disabled by AGENTHUB_ENABLE_TERMINAL=false');
    }

    const cwd = await this.ensureWorkspace(conversationId);
    const timeoutMs = clampInt(input.timeoutMs ?? 20_000, 1_000, 120_000);
    const maxOutput = 32_000;

    return await new Promise<TerminalRunResult>((resolve) => {
      const child = spawn(input.command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, AGENTHUB_WORKSPACE: cwd },
      });

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let timedOut = false;
      let settled = false;

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
          cwd,
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
        resolve({
          command: input.command,
          cwd,
          exitCode: code,
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
    description: 'Run a shell command in the current conversation workspace and return stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run from the workspace root.' },
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

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${target}`);
  }
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function shouldIgnore(name: string): boolean {
  return name === '.git' || name === 'node_modules' || name === '.next' || name === 'dist' || name === '.turbo';
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
