import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { ResolvedManifestDeployment } from './config/deployment_env_manifest.js';
import { assertNodeRollupVersion, assertSimulateV1Supported } from './main.js';

const READ_RPC_URL = 'https://eth-mainnet.example.com/v2/secret-api-key';

function clientAnsweringWith(outcome: Promise<unknown>) {
  return { simulateBlocks: () => outcome } as unknown as Parameters<typeof assertSimulateV1Supported>[0];
}

describe('assertSimulateV1Supported', () => {
  it('passes when the read RPC answers the probe', async () => {
    await expect(
      assertSimulateV1Supported(clientAnsweringWith(Promise.resolve([{ calls: [] }])), READ_RPC_URL),
    ).resolves.toBeUndefined();
  });

  it('fails startup on a method-not-found error, naming the host but not the URL', async () => {
    const error = Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), {
      code: -32601,
    });
    await expect(assertSimulateV1Supported(clientAnsweringWith(Promise.reject(error)), READ_RPC_URL)).rejects.toThrow(
      'l1-operations mode needs a read RPC that supports eth_simulateV1; eth-mainnet.example.com answered: ' +
        'the method eth_simulateV1 does not exist/is not available',
    );
    await expect(
      assertSimulateV1Supported(clientAnsweringWith(Promise.reject(error)), READ_RPC_URL),
    ).rejects.not.toThrow('secret-api-key');
  });

  it('fails startup on a plain-text HTTP error', async () => {
    await expect(
      assertSimulateV1Supported(
        clientAnsweringWith(Promise.reject(new Error('HTTP request failed. Status: 403 only core evm requests'))),
        READ_RPC_URL,
      ),
    ).rejects.toThrow('eth-mainnet.example.com answered: HTTP request failed. Status: 403 only core evm requests');
  });
});

describe('assertNodeRollupVersion', () => {
  const portal = EthAddress.fromString('0x00000000000000000000000000000000000000a1');
  const pinned = { label: 'v4', publicConfig: { portal, rollupVersion: 4n } } as ResolvedManifestDeployment;

  it("passes when the node follows the pinned entry's rollup", () => {
    expect(() => assertNodeRollupVersion(4n, pinned)).not.toThrow();
  });

  it('refuses to start on another rollup, naming both versions and the pinned entry', () => {
    expect(() => assertNodeRollupVersion(5n, pinned)).toThrow(
      `node reports rollup version 5, but the pinned entry v4:${portal.toString()} is on 4`,
    );
  });
});
