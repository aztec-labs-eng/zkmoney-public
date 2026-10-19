/**
 * The device class a proof's timing depends on, stamped on timing events: cross-origin isolation
 * (bb.js proves on one thread without it) and the core count. Never an identifier.
 */
export function provingDevice(): { cross_origin_isolated: boolean; hardware_concurrency?: number } {
  return {
    cross_origin_isolated: globalThis.crossOriginIsolated === true,
    hardware_concurrency: globalThis.navigator?.hardwareConcurrency || undefined,
  }
}
