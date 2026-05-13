import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdapterModule } from './adapter/adapter.module.js';
import { ConversationModule } from './conversation/conversation.module.js';
import { OrchestratorModule } from './orchestrator/orchestrator.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';
import { DeployModule } from './deploy/deploy.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    AdapterModule,
    ConversationModule,
    OrchestratorModule,
    WorkspaceModule,
    SandboxModule,
    DeployModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
