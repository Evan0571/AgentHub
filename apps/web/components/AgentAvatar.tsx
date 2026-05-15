'use client';

import type { ComponentType } from 'react';
import clsx from 'clsx';
import {
  Anthropic,
  Claude,
  DeepSeek,
  Doubao,
  OpenAI,
  Qwen,
  Ollama,
  Gemini,
  ByteDance,
} from '@lobehub/icons';

/**
 * Brand SVG components shipped by `@lobehub/icons` (MIT, comprehensive AI
 * brand pack). Each exported component is a monochrome `<svg>` taking
 * `{ color, size }`, so we drop it onto the agent's colored square and the
 * logo silhouette shows in white.
 *
 * Adapters not in this map fall back to the colored letter — same shape +
 * size as the brand version, so layout stays uniform.
 */
type LobeIcon = ComponentType<{ color?: string; size?: number | string }>;

const BRAND: Record<string, { Icon: LobeIcon; label: string }> = {
  deepseek: { Icon: DeepSeek as LobeIcon, label: 'DeepSeek' },
  'deepseek-v3': { Icon: DeepSeek as LobeIcon, label: 'DeepSeek' },
  'deepseek-r1': { Icon: DeepSeek as LobeIcon, label: 'DeepSeek' },
  openai: { Icon: OpenAI as LobeIcon, label: 'OpenAI' },
  codex: { Icon: OpenAI as LobeIcon, label: 'OpenAI' },
  'openai-compatible': { Icon: OpenAI as LobeIcon, label: 'OpenAI-compatible' },
  anthropic: { Icon: Anthropic as LobeIcon, label: 'Anthropic' },
  'claude-code': { Icon: Claude as LobeIcon, label: 'Claude' },
  claude: { Icon: Claude as LobeIcon, label: 'Claude' },
  doubao: { Icon: Doubao as LobeIcon, label: '豆包' },
  bytedance: { Icon: ByteDance as LobeIcon, label: 'ByteDance' },
  qwen: { Icon: Qwen as LobeIcon, label: '通义千问' },
  ollama: { Icon: Ollama as LobeIcon, label: 'Ollama' },
  gemini: { Icon: Gemini as LobeIcon, label: 'Gemini' },
};

export function AgentAvatar({
  name,
  adapterId,
  color,
  size = 32,
  className,
  rounded = 'rounded',
  fontSizeRatio = 0.45,
}: {
  name: string;
  adapterId: string;
  color: string;
  size?: number;
  className?: string;
  rounded?: 'rounded' | 'rounded-sm' | 'rounded-md' | 'rounded-lg' | 'rounded-full';
  fontSizeRatio?: number;
}) {
  const brand = BRAND[adapterId];

  const baseClass = clsx(
    'shrink-0 flex items-center justify-center font-bold text-white select-none',
    rounded,
    className,
  );
  const baseStyle = { width: size, height: size, background: color } as const;

  if (brand) {
    const { Icon, label } = brand;
    return (
      <span className={baseClass} style={baseStyle} title={label}>
        <Icon color="#ffffff" size={Math.round(size * 0.6)} />
      </span>
    );
  }

  return (
    <span
      className={baseClass}
      style={{ ...baseStyle, fontSize: Math.round(size * fontSizeRatio) }}
    >
      {(name[0] ?? '?').toUpperCase()}
    </span>
  );
}
