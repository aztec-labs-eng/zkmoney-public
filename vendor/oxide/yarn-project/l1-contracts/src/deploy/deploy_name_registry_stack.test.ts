import { describe, expect, it, jest } from '@jest/globals';
import type { PublicClient, WalletClient } from 'viem';

import { deployNameRegistryStack } from '../index.js';

const DEPLOYER = '0x1111111111111111111111111111111111111111';
const VERIFIER = '0x2222222222222222222222222222222222222222';
const DOMAIN_OWNER = '0x3333333333333333333333333333333333333333';
const DEPLOYED = [
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '0xcccccccccccccccccccccccccccccccccccccccc',
  '0xdddddddddddddddddddddddddddddddddddddddd',
];

function fakeClients(account: { address: string } | null = { address: DEPLOYER }) {
  const contractAddresses = [...DEPLOYED];
  const deployContract = jest.fn((_request: unknown) => Promise.resolve('0xdeploy'));
  const writeContract = jest.fn((_request: unknown) => Promise.resolve('0xwrite'));
  const waitForTransactionReceipt = jest.fn((request: any) =>
    Promise.resolve({
      status: 'success',
      blockNumber: 1n,
      contractAddress: request.hash === '0xdeploy' ? contractAddresses.shift() : undefined,
    }),
  );
  return {
    wallet: { account: account ?? undefined, deployContract, writeContract } as unknown as WalletClient,
    publicClient: { waitForTransactionReceipt } as unknown as PublicClient,
    deployContract,
    writeContract,
  };
}

describe('deployNameRegistryStack', () => {
  it('returns the four deployed addresses in deployment order', async () => {
    const { wallet, publicClient } = fakeClients();
    await expect(deployNameRegistryStack(wallet, publicClient, VERIFIER, DOMAIN_OWNER)).resolves.toEqual({
      nameRegistry: DEPLOYED[0],
      sipaFactory: DEPLOYED[1],
      accountMetadataRegistry: DEPLOYED[2],
      sipaResolver: DEPLOYED[3],
    });
  });

  it('constructs each contract from the addresses the earlier deployments produced', async () => {
    const { wallet, publicClient, deployContract } = fakeClients();
    await deployNameRegistryStack(wallet, publicClient, VERIFIER, DOMAIN_OWNER);
    const args = deployContract.mock.calls.map(([request]: any[]) => request.args);
    expect(args).toEqual([[DEPLOYER, DOMAIN_OWNER], [DEPLOYER], [DEPLOYED[0]], [DEPLOYED[0], DEPLOYED[1], VERIFIER]]);
  });

  it('points the name registry at the metadata registry and the resolver', async () => {
    const { wallet, publicClient, writeContract } = fakeClients();
    await deployNameRegistryStack(wallet, publicClient, VERIFIER, DOMAIN_OWNER);
    expect(
      writeContract.mock.calls.map(([request]: any[]) => [request.address, request.functionName, request.args]),
    ).toEqual([
      [DEPLOYED[0], 'updateAccountMetadataRegistry', [DEPLOYED[2]]],
      [DEPLOYED[0], 'updateResolver', [DEPLOYED[3]]],
    ]);
  });

  it('throws before any deployment when the wallet client has no account', async () => {
    const { wallet, publicClient, deployContract } = fakeClients(null);
    await expect(deployNameRegistryStack(wallet, publicClient, VERIFIER, DOMAIN_OWNER)).rejects.toThrow(
      /no account to deploy the NameRegistry stack from/,
    );
    expect(deployContract).not.toHaveBeenCalled();
  });
});
