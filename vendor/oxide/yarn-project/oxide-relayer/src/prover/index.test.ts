import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import { type EpochProofsDeps, startEpochProofs } from './index.js';

const config = { modes: ['epoch-proofs'], proverNodeUrl: 'https://prover.example' } as unknown as RunConfig;

const deploymentWithProverSubsidy = (proverSubsidy: EthAddress): ResolvedManifestDeployment =>
  ({
    label: 'v1',
    publicConfig: { portal: EthAddress.random(), proverSubsidy },
  }) as unknown as ResolvedManifestDeployment;

describe('startEpochProofs', () => {
  it('refuses to start when the pinned entry publishes the zero address for proverSubsidy', async () => {
    const deps = { l1TxUtils: {}, l1SubmissionBatcher: {}, priceOracle: {} } as unknown as EpochProofsDeps;

    await expect(startEpochProofs(config, deploymentWithProverSubsidy(EthAddress.ZERO), deps)).rejects.toThrow(
      /zero address for proverSubsidy/,
    );
  });

  it('starts nothing while submission is disabled', async () => {
    const deps = { priceOracle: {} } as unknown as EpochProofsDeps;

    const service = await startEpochProofs(config, deploymentWithProverSubsidy(EthAddress.ZERO), deps);

    await expect(service.stop()).resolves.toBeUndefined();
  });
});
