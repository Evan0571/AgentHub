import { Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { DeployService } from './deploy.service.js';

const StartDeploySchema = z.object({
  conversationId: z.string().min(1),
  snapshotId: z.string().min(1),
  target: z.enum(['vercel', 'cloudflare', 'render', 'docker']),
});

@Controller('deploy')
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  @Post()
  async start(@Body() body: unknown) {
    const input = StartDeploySchema.parse(body);
    return this.deploy.start(input);
  }
}
