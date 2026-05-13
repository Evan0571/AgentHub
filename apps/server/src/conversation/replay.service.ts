import { Injectable } from '@nestjs/common';
import type { ClientEvent, ServerEvent, ReplayFrame } from '@agenthub/shared-types';

/**
 * Group-chat replay (PRD §F2.7).
 * Streams historical frames (messages, plan changes, patches, deploys)
 * to the client at configurable speed.
 */
@Injectable()
export class ReplayService {
  async stream(
    event: Extract<ClientEvent, { op: 'replay_request' }>,
    send: (e: ServerEvent) => void,
  ): Promise<void> {
    // TODO: pull from messages / plans / snapshots / deployments tables,
    // interleave by createdAt, then emit one frame at a time.
    const speed = event.speed ?? 1;
    const demo: ReplayFrame[] = [{ kind: 'done' }];
    for (const frame of demo) {
      send({ op: 'replay_frame', frame });
      await sleep(50 / speed);
    }
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
