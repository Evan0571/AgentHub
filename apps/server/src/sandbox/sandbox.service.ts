import { Injectable } from '@nestjs/common';

export type SandboxProvider = 'mock' | 'e2b' | 'docker' | 'webcontainer';

export interface StartSandboxInput {
  conversationId: string;
  snapshotId: string;
  provider?: SandboxProvider;
}

export interface SandboxHandle {
  id: string;
  url: string;
  expiresAt: string;
}

/**
 * Sandbox provider abstraction. Concrete drivers:
 *  - mock: returns a fake URL for offline demo
 *  - e2b:  E2B cloud sandbox via @e2b/code-interpreter
 *  - docker: spin up a local container with reverse proxy
 *  - webcontainer: front-end only (StackBlitz)
 */
@Injectable()
export class SandboxService {
  async start(input: StartSandboxInput): Promise<SandboxHandle> {
    const provider = (input.provider ?? process.env.SANDBOX_PROVIDER ?? 'mock') as SandboxProvider;
    // TODO: switch(provider) and dispatch to driver implementations.
    void input;
    return {
      id: cryptoRandomId(),
      url: provider === 'mock' ? 'about:blank' : `https://sandbox.example/${cryptoRandomId()}`,
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    };
  }

  async stop(_id: string): Promise<void> {
    /* TODO */
  }
}

function cryptoRandomId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
