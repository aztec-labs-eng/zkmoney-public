import { EthAddress } from '@aztec/foundation/eth-address';

import type { TeeSigner } from '@oxide/oxide-lib/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { DeploymentEnvManifestPublicConfig } from '../config/deployment_env_manifest.js';
import type { L1TxQueue } from '../l1/l1_tx_queue.js';
import type { ChainlinkPriceOracle } from '../price_oracle/chainlink_price_oracle.js';

const connect = jest.fn(() => Promise.resolve({} as TeeSigner));
jest.unstable_mockModule('@oxide/oxide-client/fleet_signer.js', () => ({ FleetSigner: { connect } }));
const create = jest.fn((_args: { signer: TeeSigner }) => Promise.resolve({ start: () => Promise.resolve() }));
jest.unstable_mockModule('./prover_claim/oxide_prover_claim_reward_collector.js', () => ({
  OxideProverClaimRewardCollector: { create },
}));
const { startProverClaimCollector } = await import('./start_prover_claim_collector.js');

const config = { aztecNodeUrl: 'http://node.example' } as unknown as RunConfig;
const client = {} as PublicClient;
const l1TxQueue = { address: EthAddress.random().toString() } as L1TxQueue;
const priceOracle = {} as ChainlinkPriceOracle;

function publicConfig(enclaveUrl: string): DeploymentEnvManifestPublicConfig {
  return {
    portal: EthAddress.random(),
    proverSubsidy: EthAddress.random(),
    enclaveUrl,
  } as unknown as DeploymentEnvManifestPublicConfig;
}

describe('startProverClaimCollector', () => {
  beforeEach(() => {
    connect.mockClear();
    create.mockClear();
  });

  it('finalizes claims with an injected signer and needs no enclave', async () => {
    const signer = {} as TeeSigner;

    await startProverClaimCollector(config, publicConfig(''), client, l1TxQueue, priceOracle, signer);

    expect(connect).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0].signer).toBe(signer);
  });

  it('connects to the published enclave fleet when no signer is injected', async () => {
    await startProverClaimCollector(config, publicConfig('https://enclave.example'), client, l1TxQueue, priceOracle);

    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with neither an injected signer nor a published enclave', async () => {
    await expect(startProverClaimCollector(config, publicConfig(''), client, l1TxQueue, priceOracle)).rejects.toThrow(
      /requires enclaveUrl/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
