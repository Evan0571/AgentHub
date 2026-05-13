import { Injectable } from '@nestjs/common';

export type DeployTarget = 'vercel' | 'cloudflare' | 'render' | 'docker';

export interface StartDeployInput {
  conversationId: string;
  snapshotId: string;
  target: DeployTarget;
}

@Injectable()
export class DeployService {
  async start(input: StartDeployInput): Promise<{ id: string; status: string }> {
    // TODO: dispatch by target → vendor API.
    void input;
    return { id: cryptoRandomId(), status: 'queued' };
  }

  async rollback(_deploymentId: string): Promise<void> {
    /* TODO */
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
