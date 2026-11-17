import { readFileSync } from 'node:fs';

/**
 * Sits apart from the circuit artifact so witness generation does not depend on a file only `yarn build` puts here.
 * The `.bin` suffix keeps the blob from shadowing this module under jest's extension-stripping resolver.
 */
export const ResolverCircuitVk = new Uint8Array(readFileSync(new URL('./vk.bin', import.meta.url)));
