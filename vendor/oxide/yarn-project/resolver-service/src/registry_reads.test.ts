import { ForwardingTableAbi, MAINNET_CHAIN_ID, MAINNET_DAI, MAINNET_USDC, MAINNET_USDT } from '@oxide/l1-contracts';

import { describe, expect, it } from '@jest/globals';
import { type Address, ContractFunctionRevertedError, type Hex, type PublicClient, zeroAddress, zeroHash } from 'viem';

import { readRegistration, undepositableReason } from './registry_reads.js';

const TABLE = '0x00000000000000000000000000000000000000f1' as Address;
const DAI = '0x00000000000000000000000000000000000000d1' as Address;
const USDC = '0x00000000000000000000000000000000000000d2' as Address;
const DAI_PORTAL = '0x00000000000000000000000000000000000000a1' as Address;
const USDC_PORTAL = '0x00000000000000000000000000000000000000a2' as Address;
const ROLLUP = '0x00000000000000000000000000000000000000b1';

/** A table of rollup version 5 that routes each token of `rows` to its portal, on the canonical rollup. */
function client(
  rows: Record<Address, Address>,
  chain: { frozen?: Address[]; canonicalRollup?: string; chainId?: bigint } = {},
) {
  const readContract = ({
    address,
    functionName,
    args,
  }: {
    address: Address;
    functionName: string;
    args?: [Address];
  }) => {
    switch (functionName) {
      case 'ROLLUP_VERSION':
        return Promise.resolve(5n);
      case 'rowFor': {
        const portal = rows[args![0].toLowerCase() as Address];
        if (!portal) {
          return Promise.reject(new ContractFunctionRevertedError({ abi: ForwardingTableAbi, functionName }));
        }
        return Promise.resolve([portal, TABLE, 0n, 0n]);
      }
      case '$frozen':
        return Promise.resolve(chain.frozen?.includes(address) ?? false);
      case 'ROLLUP':
        return Promise.resolve(ROLLUP);
      case 'REGISTRY':
        return Promise.resolve('0x00000000000000000000000000000000000000c1');
      case 'getCanonicalRollup':
        return Promise.resolve(chain.canonicalRollup ?? ROLLUP);
    }
    throw new Error(`unexpected read ${functionName}`);
  };
  return {
    readContract,
    getChainId: () => Promise.resolve(Number(chain.chainId ?? 31337n)),
  } as unknown as PublicClient;
}

describe('undepositableReason', () => {
  it('accepts a deposit row with an open portal on the canonical rollup', async () => {
    await expect(undepositableReason(client({ [DAI]: DAI_PORTAL }), TABLE, 5n, [DAI])).resolves.toBeUndefined();
  });

  it('refuses a table for another rollup version', async () => {
    await expect(undepositableReason(client({ [DAI]: DAI_PORTAL }), TABLE, 4n, [DAI])).resolves.toMatch(
      /rollup version 4, but .* serves 5/,
    );
  });

  it('refuses a frozen portal and a portal whose rollup is not canonical', async () => {
    const rows = { [DAI]: DAI_PORTAL };
    await expect(undepositableReason(client(rows, { frozen: [DAI_PORTAL] }), TABLE, 5n, [DAI])).resolves.toMatch(
      /frozen/,
    );
    const newRollup = '0x00000000000000000000000000000000000000b2';
    await expect(undepositableReason(client(rows, { canonicalRollup: newRollup }), TABLE, 5n, [DAI])).resolves.toMatch(
      /canonical/,
    );
  });

  it('accepts a table while one deposit token can still deposit', async () => {
    const rows = { [DAI]: DAI_PORTAL, [USDC]: USDC_PORTAL };
    await expect(
      undepositableReason(client(rows, { frozen: [DAI_PORTAL] }), TABLE, 5n, [DAI, USDC]),
    ).resolves.toBeUndefined();
  });

  it('accepts USDC and USDT on mainnet through the DAI row', async () => {
    const rows = { [MAINNET_DAI.toString() as Address]: DAI_PORTAL };
    const mainnet = client(rows, { chainId: MAINNET_CHAIN_ID });
    const tokens = [MAINNET_USDC, MAINNET_USDT].map(token => token.toString() as Address);
    await expect(undepositableReason(mainnet, TABLE, 5n, tokens)).resolves.toBeUndefined();
    await expect(undepositableReason(client(rows), TABLE, 5n, tokens)).resolves.toMatch(/lists no deposit/);
  });

  it('refuses a table that routes no deposit token', async () => {
    await expect(undepositableReason(client({ [DAI]: DAI_PORTAL }), TABLE, 5n, [USDC])).resolves.toMatch(
      /lists no deposit/,
    );
  });
});

describe('readRegistration', () => {
  const NAME_REGISTRY = '0x00000000000000000000000000000000000000e1' as Address;
  const METADATA_REGISTRY = '0x00000000000000000000000000000000000000e2' as Address;
  const OWNER = '0x00000000000000000000000000000000000000e3' as Address;

  function registry(owners: Record<Hex, Address>, recordHolders: Address[]) {
    const readContract = ({ functionName, args }: { functionName: string; args?: [Hex] }) => {
      switch (functionName) {
        case 'ownerOf':
          return Promise.resolve(owners[args![0]] ?? zeroAddress);
        case 'accountMetadataRegistry':
          return Promise.resolve(METADATA_REGISTRY);
        case 'hasUserRecord':
          return Promise.resolve(recordHolders.includes(args![0] as Address));
      }
      throw new Error(`unexpected read ${functionName}`);
    };
    return { readContract } as unknown as PublicClient;
  }

  it('returns the reason for a name that has no owner', async () => {
    await expect(readRegistration(registry({}, [OWNER]), NAME_REGISTRY, zeroHash)).resolves.toBe(
      `name not registered: ${zeroHash}`,
    );
  });

  it('returns the reason for an owner with no record in the current metadata registry', async () => {
    await expect(readRegistration(registry({ [zeroHash]: OWNER }, []), NAME_REGISTRY, zeroHash)).resolves.toBe(
      `name has no record in the current metadata registry: ${zeroHash}`,
    );
  });
});
