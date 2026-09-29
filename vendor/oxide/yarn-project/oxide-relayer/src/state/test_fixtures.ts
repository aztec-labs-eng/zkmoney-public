import type { RelayerDeployment } from './types.js';

/** Stable deployment fixture for relayer state store tests. */
export const TEST_RELAYER_DEPLOYMENT: RelayerDeployment = {
  chainId: 1n,
  portal: '0x0000000000000000000000000000000000000001',
  l2Token: `0x${'11'.repeat(32)}`,
  rollupVersion: 4n,
  broadcaster: `0x${'22'.repeat(32)}`,
};
