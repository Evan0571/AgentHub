import { Injectable, Logger } from '@nestjs/common';
import type { ServerEvent } from '@agenthub/shared-types';
import { VercelDriver, mapVercelState } from './vercel-driver.js';

const POLL_INTERVAL_MS = 2_500;
const POLL_TIMEOUT_MS = 180_000;

export type DeployTarget = 'vercel' | 'mock';

export interface DeployInput {
  conversationId: string;
  target: DeployTarget;
  html: string;
  projectName?: string;
}

interface MockDeployment {
  id: string;
  conversationId: string;
  html: string;
  createdAt: string;
}

@Injectable()
export class DeployService {
  private readonly log = new Logger('DeployService');
  private readonly mockStore = new Map<string, MockDeployment>();

  /**
   * Fire-and-forget deploy. Returns the initial snapshot synchronously and
   * keeps pushing deploy_status events to `send` as the build progresses.
   */
  async deploy(input: DeployInput, send: (e: ServerEvent) => void): Promise<void> {
    const target = this.resolveTarget(input.target);
    if (target === 'vercel') {
      await this.deployVercel(input, send);
    } else {
      this.deployMock(input, send);
    }
  }

  /** Public URL for a mock deployment served by our own server (see controller). */
  getMockHtml(id: string): string | undefined {
    return this.mockStore.get(id)?.html;
  }

  /**
   * If the user asked for vercel but we don't have a token, silently fall back
   * to the mock driver so the demo still works end-to-end.
   */
  private resolveTarget(requested: DeployTarget): DeployTarget {
    if (requested === 'vercel' && !process.env.VERCEL_TOKEN) {
      this.log.warn('VERCEL_TOKEN not set — falling back to mock deploy');
      return 'mock';
    }
    return requested;
  }

  private async deployVercel(input: DeployInput, send: (e: ServerEvent) => void) {
    const token = process.env.VERCEL_TOKEN!;
    const driver = new VercelDriver(token, process.env.VERCEL_TEAM_ID);
    const name = sanitizeName(input.projectName ?? `agenthub-${shortId()}`);

    let snapshot;
    try {
      snapshot = await driver.create({ name, html: input.html });
    } catch (e) {
      send({
        op: 'deploy_status',
        deploymentId: 'failed-' + shortId(),
        conversationId: input.conversationId,
        target: 'vercel',
        status: 'failed',
        errorMessage: e instanceof Error ? e.message : String(e),
        createdAt: new Date().toISOString(),
      });
      return;
    }

    const baseEvt = {
      deploymentId: snapshot.id,
      conversationId: input.conversationId,
      target: 'vercel' as const,
      createdAt: new Date().toISOString(),
    };

    send({
      op: 'deploy_status',
      ...baseEvt,
      status: mapVercelState(snapshot.readyState),
      url: `https://${snapshot.url}`,
    });

    // Poll until terminal state or timeout.
    const startedAt = Date.now();
    while (Date.now() - startedAt < POLL_TIMEOUT_MS) {
      await sleep(POLL_INTERVAL_MS);
      let s;
      try {
        s = await driver.get(snapshot.id);
      } catch (e) {
        this.log.warn(`vercel poll failed: ${(e as Error).message}`);
        continue;
      }
      const mapped = mapVercelState(s.readyState);
      send({
        op: 'deploy_status',
        ...baseEvt,
        status: mapped,
        url: `https://${s.url}`,
        ...(s.errorMessage ? { errorMessage: s.errorMessage } : {}),
      });
      if (mapped === 'ready' || mapped === 'failed') return;
    }

    send({
      op: 'deploy_status',
      ...baseEvt,
      status: 'failed',
      errorMessage: `deployment timeout after ${POLL_TIMEOUT_MS / 1000}s`,
    });
  }

  private deployMock(input: DeployInput, send: (e: ServerEvent) => void) {
    const id = shortId();
    const created: MockDeployment = {
      id,
      conversationId: input.conversationId,
      html: input.html,
      createdAt: new Date().toISOString(),
    };
    this.mockStore.set(id, created);

    const port = process.env.SERVER_PORT ?? '4000';
    const url = `http://localhost:${port}/api/deploy/preview/${id}`;
    const baseEvt = {
      deploymentId: id,
      conversationId: input.conversationId,
      target: 'mock' as const,
      createdAt: created.createdAt,
    };
    // Mock builds are instant.
    send({ op: 'deploy_status', ...baseEvt, status: 'building' });
    setTimeout(() => {
      send({ op: 'deploy_status', ...baseEvt, status: 'ready', url });
    }, 250);
  }
}

function sanitizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'agenthub';
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
