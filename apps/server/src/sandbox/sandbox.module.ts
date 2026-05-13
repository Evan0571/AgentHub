import { Module } from '@nestjs/common';
import { SandboxService } from './sandbox.service.js';
import { ShareLinkService } from './share-link.service.js';

@Module({
  providers: [SandboxService, ShareLinkService],
  exports: [SandboxService, ShareLinkService],
})
export class SandboxModule {}
