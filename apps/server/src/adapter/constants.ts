/** DI token for the AdapterRegistry, in a separate file so consumers can
 * import it without pulling adapter.module.ts (which would cycle through
 * adapter.factory.ts). */
export const ADAPTER_REGISTRY = 'ADAPTER_REGISTRY';
