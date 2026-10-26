import { EthAddress } from '@aztec-labs/foundation/eth-address';

import type { RegisteredTeeSigner } from '@oxide/oxide-client/types.js';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PublicClient } from 'viem';

import type { RunConfig } from '../cli/config.js';
import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import type { L1TxQueue } from '../l1/l1_tx_queue.js';
import type { PriceOracle } from '../price_oracle/price_oracle.js';

const connect = jest.fn((_enclaveUrl: string, _portal: unknown) => Promise.resolve({} as RegisteredTeeSigner));
jest.unstable_mockModule('@oxide/oxide-client/fleet_signer.js', () => ({ FleetSigner: { connect } }));
const create = jest.fn((_args: { portals: { signer: RegisteredTeeSigner }[] }) =>
  Promise.resolve({ start: () => Promise.resolve() }),
);
jest.unstable_mockModule('./prover_claim/oxide_prover_claim_reward_collector.js', () => ({
  OxideProverClaimRewardCollector: { create },
}));
const { startProverClaimCollector } = await import('./start_prover_claim_collector.js');

const config = { aztecNodeUrl: 'http://node.example' } as unknown as RunConfig;
const client = {} as PublicClient;
const l1TxQueue = { address: EthAddress.random().toString() } as L1TxQueue;
const priceOracle = {} as PriceOracle;

function deployment(enclaveUrl: string): ResolvedManifestDeployment {
  return {
    label: 'v1',
    publicConfig: { portal: EthAddress.random(), proverSubsidy: EthAddress.random(), enclaveUrl },
  } as unknown as ResolvedManifestDeployment;
}

describe('startProverClaimCollector', () => {
  beforeEach(() => {
    connect.mockClear();
    create.mockClear();
  });

  it('finalizes claims with an injected signer and needs no enclave', async () => {
    const signer = {} as RegisteredTeeSigner;

    await startProverClaimCollector(config, [deployment(''), deployment('')], client, l1TxQueue, priceOracle, signer);

    expect(connect).not.toHaveBeenCalled();
    expect(create.mock.calls[0]![0].portals.map(portal => portal.signer)).toEqual([signer, signer]);
  });

  it('connects to the enclave fleet that each entry publishes when no signer is injected', async () => {
    const deployments = [deployment('https://a.enclave.example'), deployment('https://b.enclave.example')];

    await startProverClaimCollector(config, deployments, client, l1TxQueue, priceOracle);

    expect(connect.mock.calls.map(([enclaveUrl]) => enclaveUrl)).toEqual([
      'https://a.enclave.example',
      'https://b.enclave.example',
    ]);
  });

  it('refuses to start when an entry publishes no enclave and no signer is injected', async () => {
    const deployments = [deployment('https://enclave.example'), deployment('')];

    await expect(startProverClaimCollector(config, deployments, client, l1TxQueue, priceOracle)).rejects.toThrow(
      /requires enclaveUrl/,
    );
    expect(create).not.toHaveBeenCalled();
  });
});
