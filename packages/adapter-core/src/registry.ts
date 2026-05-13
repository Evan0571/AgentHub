import type { AgentAdapter, Capabilities } from './types.js';

/** Runtime registry — Orchestrator/Conversation look up adapters by id. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`adapter ${adapter.id} already registered`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`adapter ${id} not found`);
    return a;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /**
   * Capability-aware lookup used by Orchestrator when a Task requires
   * specific capabilities (e.g. fileEdit + codeExecution).
   */
  findByCapability(required: Partial<Capabilities>): AgentAdapter[] {
    return this.list().filter((a) =>
      Object.entries(required).every(([k, v]) => {
        const actual = (a.capabilities as unknown as Record<string, unknown>)[k];
        if (typeof v === 'boolean') return v ? actual === true : true;
        if (typeof v === 'number') return typeof actual === 'number' && actual >= v;
        return true;
      }),
    );
  }
}
