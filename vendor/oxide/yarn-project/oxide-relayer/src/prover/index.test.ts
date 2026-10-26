import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import { type EpochProofsDeps, startEpochProofs } from './index.js';

const config = { modes: ['epoch-proofs'], proverNodeUrl: 'https://prover.example' } as unknown as RunConfig;

const manifestWithProverSubsidy = (proverSubsidy: EthAddress) => ({
  current: {
    label: 'v1',
    publicConfig: { portal: EthAddress.random(), proverSubsidy, rollupVersion: 7n },
  } as unknown as ResolvedManifestDeployment,
  historical: [],
});

describe('startEpochProofs', () => {
  it('refuses to start when the pinned entry publishes the zero address for proverSubsidy', async () => {
    // Every read is the portal's underlying.
    const client = { readContract: () => Promise.resolve(EthAddress.random().toString()) };
    const node = { getNodeInfo: () => Promise.resolve({ rollupVersion: 7 }) };
    const deps = { client, node, l1TxQueue: {} } as unknown as EpochProofsDeps;

    await expect(startEpochProofs(config, manifestWithProverSubsidy(EthAddress.ZERO), deps)).rejects.toThrow(
      /zero address for proverSubsidy/,
    );
  });
});
