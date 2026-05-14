import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { DeployService } from './deploy.service.js';

/** Express Response shape (minimally typed to avoid pulling @types/express). */
interface ResponseLike {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/**
 * REST surface for the mock deploy driver. The Vercel driver returns
 * vercel.app URLs directly, so it doesn't need this endpoint.
 *
 * Triggering a deploy is done via WebSocket (`op: 'deploy'`) — see
 * ConversationGateway — not via REST, so we don't need a POST endpoint here.
 */
@Controller('api/deploy')
export class DeployController {
  constructor(private readonly deploy: DeployService) {}

  @Get('preview/:id')
  servePreview(@Param('id') id: string, @Res() res: ResponseLike) {
    const html = this.deploy.getMockHtml(id);
    if (!html) throw new NotFoundException('deployment not found');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.send(html);
  }
}
