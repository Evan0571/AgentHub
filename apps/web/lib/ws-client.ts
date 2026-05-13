'use client';

import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';

/** Minimal WS client — auto-reconnect, message queue while connecting, fan-out subscribers. */
export class AgentHubWS {
  private ws?: WebSocket;
  private subs = new Set<(e: ServerEvent) => void>();
  private queue: ClientEvent[] = [];
  private retry = 0;

  constructor(private readonly url: string) {}

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retry = 0;
      // Flush anything queued while CONNECTING.
      const pending = this.queue.splice(0);
      for (const ev of pending) this.send(ev);
    };
    this.ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { event: string; data: ServerEvent };
        if (parsed.event === 'server_event') {
          for (const s of this.subs) s(parsed.data);
        }
      } catch (e) {
        console.warn('ws parse error', e);
      }
    };
    this.ws.onclose = () => {
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    this.ws.onerror = () => {
      // Let onclose handle reconnect — just don't throw uncaught.
    };
  }

  send(event: ClientEvent) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'client_event', data: event }));
    } else {
      this.queue.push(event);
    }
  }

  subscribe(fn: (e: ServerEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
}
