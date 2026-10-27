import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses';
import { Fr } from '@aztec-labs/aztec.js/fields';
import { CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS } from '@aztec-labs/constants';
import { type ContractInstanceWithAddress, getContractClassFromArtifact } from '@aztec-labs/stdlib/contract';
import {
  DelayedPublicMutableValues,
  DelayedPublicMutableValuesWithHash,
  ScheduledDelayChange,
  ScheduledValueChange,
} from '@aztec-labs/stdlib/delayed-public-mutable';

import type { OxidePortalContract } from '@oxide/l1-contracts';
import { OxideTokenContract } from '@oxide/noir-contracts.js/OxideToken';
import { TOKEN_UPDATE_DELAY } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { describe, expect, it } from '@jest/globals';

import { isOxideTokenLockedToArtifact, readOxideTokenImmutables } from './token_registration.js';

describe('readOxideTokenImmutables', () => {
  it('reads the portal handles and the underlying metadata', async () => {
    const portalAddress = EthAddress.random();
    const teeRegistry = EthAddress.random();
    const underlying = EthAddress.random();
    const metadata: Record<string, unknown> = { name: 'Dai Stablecoin', symbol: 'DAI', decimals: 18 };
    const portal = {
      address: portalAddress,
      getTeeRegistry: () => Promise.resolve(teeRegistry),
      getUnderlying: () => Promise.resolve(underlying),
      getTxAmountCap: () => Promise.resolve(2583n * 10n ** 18n),
      client: {
        readContract: ({ address, functionName }: { address: string; functionName: string }) => {
          if (address !== underlying.toString()) {
            throw new Error(`unexpected read of ${address}`);
          }
          return Promise.resolve(metadata[functionName]);
        },
      },
    } as unknown as OxidePortalContract;

    await expect(readOxideTokenImmutables(portal)).resolves.toEqual({
      portal: portalAddress,
      teeRegistry,
      name: 'Dai Stablecoin',
      symbol: 'DAI',
      decimals: 18,
      maxNoteAmount: 2583n * 10n ** 18n,
    });
  });
});

const TOKEN_CLASS_ID = getContractClassFromArtifact(OxideTokenContract.artifact).then(
  contractClass => contractClass.id,
);
const PAST_TIMESTAMP = 1n;
const FUTURE_TIMESTAMP = 4_000_000_000n;

describe('isOxideTokenLockedToArtifact', () => {
  it('accepts a token with its own class and the locked delay', async () => {
    const node = await fakeNode({});

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(true);
  });

  it('rejects a token whose delay is not locked', async () => {
    const node = await fakeNode({ delay: ScheduledDelayChange.empty() });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });

  it('rejects a locked token with a class change scheduled before the lock', async () => {
    const node = await fakeNode({
      classChange: new ScheduledValueChange([Fr.ZERO], [Fr.random()], FUTURE_TIMESTAMP),
    });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });

  it('accepts a locked token with a class change scheduled to its own class', async () => {
    const node = await fakeNode({
      classChange: new ScheduledValueChange([Fr.ZERO], [await TOKEN_CLASS_ID], FUTURE_TIMESTAMP),
    });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(true);
  });

  it('rejects a locked token whose current class is another class', async () => {
    const node = await fakeNode({
      classChange: new ScheduledValueChange([Fr.ZERO], [Fr.random()], PAST_TIMESTAMP),
    });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });

  it('rejects a locked token whose current class is another class with a change back scheduled', async () => {
    const node = await fakeNode({
      classChange: new ScheduledValueChange([Fr.random()], [await TOKEN_CLASS_ID], FUTURE_TIMESTAMP),
    });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });

  it('rejects a token published with another class', async () => {
    const node = await fakeNode({ originalClassId: Fr.random() });

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });

  it('rejects a token that is not published', async () => {
    const node = { ...(await fakeNode({})), getContract: () => Promise.resolve(undefined) };

    await expect(isOxideTokenLockedToArtifact(node, OxideTokenContract.artifact, node.token)).resolves.toBe(false);
  });
});

const LOCKED_DELAY = new ScheduledDelayChange(undefined, BigInt(TOKEN_UPDATE_DELAY), PAST_TIMESTAMP);

async function fakeNode(args: {
  delay?: ScheduledDelayChange;
  classChange?: ScheduledValueChange;
  originalClassId?: Fr;
}) {
  const token = await AztecAddress.random();
  const registry = AztecAddress.fromNumberUnsafe(CONTRACT_INSTANCE_REGISTRY_CONTRACT_ADDRESS);
  const originalContractClassId = args.originalClassId ?? (await TOKEN_CLASS_ID);
  const storage = new Map<string, Fr>();
  const { delayedPublicMutableSlot } = await DelayedPublicMutableValuesWithHash.getContractUpdateSlots(token);
  const values = new DelayedPublicMutableValues(
    args.classChange ?? ScheduledValueChange.empty(1),
    args.delay ?? LOCKED_DELAY,
  );
  await values.writeToTree(delayedPublicMutableSlot, (slot, value) => {
    storage.set(slot.toString(), value);
    return Promise.resolve();
  });
  return {
    token,
    getContract: (address: AztecAddress) =>
      Promise.resolve(
        !address.equals(token)
          ? undefined
          : ({ address: token, originalContractClassId } as ContractInstanceWithAddress),
      ),
    getPublicStorageAt: (_block: 'latest', contract: AztecAddress, slot: Fr) =>
      Promise.resolve(contract.equals(registry) ? (storage.get(slot.toString()) ?? Fr.ZERO) : Fr.ZERO),
  };
}
