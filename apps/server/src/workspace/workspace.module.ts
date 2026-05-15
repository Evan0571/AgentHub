import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { SnapshotService } from './snapshot.service.js';
import { AgentToolRunnerService } from './agent-tool-runner.service.js';
import { WorkspaceController } from './workspace.controller.js';

@Module({
  controllers: [WorkspaceController],
  providers: [WorkspaceService, SnapshotService, AgentToolRunnerService],
  exports: [WorkspaceService, SnapshotService, AgentToolRunnerService],
})
export class WorkspaceModule {}
