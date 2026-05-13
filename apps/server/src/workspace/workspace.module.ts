import { Module } from '@nestjs/common';
import { WorkspaceService } from './workspace.service.js';
import { SnapshotService } from './snapshot.service.js';

@Module({
  providers: [WorkspaceService, SnapshotService],
  exports: [WorkspaceService, SnapshotService],
})
export class WorkspaceModule {}
