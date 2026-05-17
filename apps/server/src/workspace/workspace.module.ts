import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { SnapshotService } from './snapshot.service.js';
import { AgentToolRunnerService } from './agent-tool-runner.service.js';
import { ProjectStateService } from './project-state.service.js';
import { WorkspaceController } from './workspace.controller.js';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService, SnapshotService, AgentToolRunnerService, ProjectStateService],
  exports: [WorkspaceService, SnapshotService, AgentToolRunnerService, ProjectStateService],
})
export class WorkspaceModule {}
