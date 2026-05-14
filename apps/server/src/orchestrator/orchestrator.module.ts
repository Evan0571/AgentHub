import { Module } from '@nestjs/common';
import { OrchestratorService } from './orchestrator.service.js';
import { PlannerService } from './planner.service.js';
import { ExecutorService } from './executor.service.js';
import { CriticService } from './critic.service.js';
import { PlanService } from './plan.service.js';

@Module({
  providers: [OrchestratorService, PlannerService, ExecutorService, CriticService, PlanService],
  // PlanService is consumed by ConversationController for /api/conversations/:id/state hydration.
  exports: [OrchestratorService, PlanService],
})
export class OrchestratorModule {}
