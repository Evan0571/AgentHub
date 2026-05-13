/**
 * Role library + Prompt template engine (PRD §5.9).
 * Templates are intentionally plain TS so they live in source control,
 * are diffable, and can be A/B compared via the Prompt Diff UI.
 */

export interface PromptRole {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  fewShots?: Array<{ user: string; assistant: string }>;
  recommendedAdapters?: string[];
  recommendedCapabilities?: Array<'fileEdit' | 'codeExecution' | 'webBrowse' | 'toolUse'>;
}

export { architect } from './roles/architect.js';
export { frontend } from './roles/frontend.js';
export { backend } from './roles/backend.js';
export { devops } from './roles/devops.js';
export { reviewer } from './roles/reviewer.js';
export { planner } from './roles/planner.js';
export { critic } from './roles/critic.js';

import { architect } from './roles/architect.js';
import { frontend } from './roles/frontend.js';
import { backend } from './roles/backend.js';
import { devops } from './roles/devops.js';
import { reviewer } from './roles/reviewer.js';
import { planner } from './roles/planner.js';
import { critic } from './roles/critic.js';

export const builtinRoles: PromptRole[] = [
  architect,
  frontend,
  backend,
  devops,
  reviewer,
  planner,
  critic,
];

/** Render a template with `{{var}}` interpolation. Unknown vars are left as-is. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
