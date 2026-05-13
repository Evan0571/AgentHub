import { Injectable } from '@nestjs/common';
import type { PlanTask } from '@agenthub/shared-types';

export interface CriticVerdict {
  verdict: 'PASS' | 'FAIL';
  reasons: string[];
  suggestedReplan?: { scope: 'this-task' | 'downstream'; hint: string };
}

@Injectable()
export class CriticService {
  /**
   * Evaluate a task's artifact against its acceptance rules.
   * TODO: dispatch by rule.kind: compile/lint/test = shell; critic-llm = LLM call.
   */
  async judge(task: PlanTask, _artifact: { artifactKind: string }): Promise<CriticVerdict> {
    void task;
    return { verdict: 'PASS', reasons: [] };
  }
}
