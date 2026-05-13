import { Module } from '@nestjs/common';
import { DeployService } from './deploy.service.js';
import { DeployController } from './deploy.controller.js';

@Module({
  providers: [DeployService],
  controllers: [DeployController],
  exports: [DeployService],
})
export class DeployModule {}
