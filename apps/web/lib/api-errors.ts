/**
 * Turn server-side errors (HTTP status + zod issue blobs + raw text) into
 * short Chinese sentences the user can act on. Falls back to a generic
 * message + the raw status code if nothing parses.
 */

/** Map server zod field names → Chinese label so messages talk about UI fields. */
const FIELD_LABELS: Record<string, string> = {
  title: '名称',
  name: '名称',
  type: '类型',
  memberAgentIds: '成员',
  groupSystemPrompt: '群规则',
  apiKey: 'API Key',
  baseUrl: 'Base URL',
  systemPrompt: 'System Prompt',
  avatarColor: '头像色',
  model: '模型',
  adapterId: '底座',
  agentId: 'Agent',
};

/** Translate common zod issue codes into Chinese verbs. */
function translateIssue(code: string, expected?: string, received?: string): string {
  // Zod messages look like "Expected string, received null".
  if (code.startsWith('Expected ') && expected && received) {
    return `应为 ${expected}，实际是 ${received}`;
  }
  if (/required/i.test(code)) return '必填';
  if (/too_small|min/i.test(code)) return '太短';
  if (/too_big|max/i.test(code)) return '太长';
  if (/invalid_url/i.test(code)) return '不是合法 URL';
  if (/invalid_string|invalid_format/i.test(code)) return '格式不正确';
  return code;
}

interface ZodErrorBlob {
  formErrors?: string[];
  fieldErrors?: Record<string, string[]>;
}

function tryParseZodBlob(raw: string): ZodErrorBlob | null {
  // The text from a NestJS BadRequestException(zod.flatten()) lands inside a
  // JSON envelope, e.g. `{"message": {...}, "error": "Bad Request", "statusCode": 400}`.
  // We also accept the bare flatten output ("formErrors": [], "fieldErrors": {...}).
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const inner =
      obj.message && typeof obj.message === 'object'
        ? (obj.message as ZodErrorBlob)
        : (obj as ZodErrorBlob);
    if (inner.formErrors || inner.fieldErrors) return inner;
    return null;
  } catch {
    return null;
  }
}

/**
 * `raw` is the body returned by fetch when !ok. The store throws
 * `new Error("create conv 400: <raw>")` so we strip the prefix and try to
 * parse the rest.
 */
export function prettifyApiError(input: Error | string, fallback = '操作失败'): string {
  const message = typeof input === 'string' ? input : input.message;

  // Strip the `<op> <status>: ` prefix the store adds.
  const match = /^(\S+(?:\s\S+)*)\s+(\d{3}):\s*([\s\S]*)$/.exec(message);
  const status = match?.[2] ? Number(match[2]) : null;
  const body = match?.[3] ?? message;

  const zod = tryParseZodBlob(body);
  if (zod) {
    const parts: string[] = [];
    for (const [field, msgs] of Object.entries(zod.fieldErrors ?? {})) {
      if (!msgs || msgs.length === 0) continue;
      const label = FIELD_LABELS[field] ?? field;
      const msg = translateIssue(msgs[0] ?? '');
      parts.push(`${label}：${msg}`);
    }
    for (const m of zod.formErrors ?? []) parts.push(translateIssue(m));
    if (parts.length > 0) return parts.join('；');
  }

  // Network-y signals.
  if (status === 401 || status === 403) return '没有权限（请检查登录 / API Key）';
  if (status === 404) return '资源不存在';
  if (status === 409) return '冲突 — 请刷新后重试';
  if (status === 429) return '请求过于频繁，稍后再试';
  if (status && status >= 500) return `服务端错误 ${status} — 看 server 控制台日志`;
  if (/fetch failed|NetworkError|Failed to fetch/i.test(body)) {
    return '连不上服务端 — 确认 server 是否在 4000 端口运行';
  }

  return fallback + (status ? `（${status}）` : '');
}
