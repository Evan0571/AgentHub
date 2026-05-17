'use client';

import type { ClientEvent, ServerEvent } from '@agenthub/shared-types';

type UserMessageEvent = Extract<ClientEvent, { op: 'user_msg' }>;

/** Auto-reconnecting WS client with queued sends and ACK-backed user messages. */
export class AgentHubWS {
  private ws?: WebSocket;
  private subs = new Set<(e: ServerEvent) => void>();
  private queue: ClientEvent[] = [];
  private pendingUserMessages = new Map<
    string,
    { event: UserMessageEvent; attempts: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private retry = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly url: string) {}

  connect(force = false) {
    if (!force && this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (force && this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.close();
    }

    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retry = 0;
      const queued = this.queue.splice(0);
      for (const ev of queued) this.transmit(ev);
      for (const pending of this.pendingUserMessages.values()) this.transmit(pending.event);
    };
    this.ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as { event: string; data: ServerEvent };
        if (parsed.event !== 'server_event') return;
        if (parsed.data.op === 'client_event_ack') {
          this.resolveAck(parsed.data.clientEventId);
          return;
        }
        for (const s of this.subs) s(parsed.data);
      } catch (e) {
        console.warn('ws parse error', e);
      }
    };
    this.ws.onclose = () => {
      const delay = Math.min(30_000, 500 * 2 ** this.retry++);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    };
    this.ws.onerror = () => {
      if (this.ws?.readyState === WebSocket.OPEN) this.connect(true);
    };
  }

  send(event: ClientEvent) {
    if (event.op === 'user_msg') {
      const clientEventId = event.clientEventId ?? `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const withId: UserMessageEvent = { ...event, clientEventId };
      if (!this.pendingUserMessages.has(clientEventId)) {
        this.pendingUserMessages.set(clientEventId, { event: withId, attempts: 0 });
      }
      this.transmit(withId);
      this.armAckTimer(clientEventId);
      return;
    }

    this.transmit(event);
  }

  subscribe(fn: (e: ServerEvent) => void) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  private transmit(event: ClientEvent) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event: 'client_event', data: event }));
      return;
    }

    this.queue.push(event);
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.connect();
    }
  }

  private armAckTimer(clientEventId: string) {
    const pending = this.pendingUserMessages.get(clientEventId);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      const latest = this.pendingUserMessages.get(clientEventId);
      if (!latest) return;
      latest.attempts += 1;
      if (latest.attempts > 3) {
        console.warn('[AgentHubWS] user_msg ack timeout', clientEventId);
        return;
      }
      this.queue.unshift(latest.event);
      this.connect(true);
      this.armAckTimer(clientEventId);
    }, 2500);
  }

  private resolveAck(clientEventId: string) {
    const pending = this.pendingUserMessages.get(clientEventId);
    if (pending?.timer) clearTimeout(pending.timer);
    this.pendingUserMessages.delete(clientEventId);
  }
}
