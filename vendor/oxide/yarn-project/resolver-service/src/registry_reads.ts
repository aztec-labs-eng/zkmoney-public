import { EthAddress } from '@aztec-labs/foundation/eth-address';

import {
  type ResolverOperatorArg,
  SipaIntent,
  type UserRecordArg,
  depositPayoutTokenFor,
  getUserRecord,
  hasUserRecord,
  readAccountMetadataRegistry,
  readForwardingTableRow,
  readResolverOperator,
  readUserAddress,
} from '@oxide/l1-contracts';

import { type Address, type Hex, type PublicClient, parseAbi, zeroAddress } from 'viem';

/** The user record plus the resolver-operator entry their name points at — everything needed to derive a SIPA. */
export type NameRegistration = {
  userAddress: Address;
  user: UserRecordArg;
  resolverOperator: ResolverOperatorArg;
};

/** Reads the rows a name points at: owner from the NameRegistry, record and operator entry from the metadata registry
 *  it points at. Returns the reason instead if the name is unregistered or has no record there. */
export async function readRegistration(
  publicClient: PublicClient,
  nameRegistry: Address,
  nameHash: Hex,
): Promise<NameRegistration | string> {
  const userAddress = await readUserAddress(publicClient, nameRegistry, nameHash);
  if (userAddress === zeroAddress) {
    return `name not registered: ${nameHash}`;
  }
  const metadataRegistry = await readAccountMetadataRegistry(publicClient, nameRegistry);
  if (!(await hasUserRecord(publicClient, metadataRegistry, userAddress))) {
    return `name has no record in the current metadata registry: ${nameHash}`;
  }
  const user = await getUserRecord(publicClient, metadataRegistry, userAddress);
  const resolverOperator = await readResolverOperator(publicClient, metadataRegistry, user.resolverOperator);
  return { userAddress, user, resolverOperator };
}

const FORWARDING_TABLE_ABI = parseAbi(['function ROLLUP_VERSION() view returns (uint256)']);

const PORTAL_ABI = parseAbi([
  'function $frozen() view returns (bool)',
  'function ROLLUP() view returns (address)',
  'function REGISTRY() view returns (address)',
]);

const AZTEC_REGISTRY_ABI = parseAbi(['function getCanonicalRollup() view returns (address)']);

/**
 * Why no sweep could deposit a SIPA for `rollupVersion` through `forwardingTable`, or undefined if one could. A sweep
 * can deposit when the table serves `rollupVersion` and the deposit row of the payout token of at least one of
 * `tokens` has an open portal on the canonical rollup. See `depositPayoutTokenFor`.
 */
export async function undepositableReason(
  publicClient: PublicClient,
  forwardingTable: Address,
  rollupVersion: bigint,
  tokens: Address[],
): Promise<string | undefined> {
  const [tableVersion, chainId] = await Promise.all([
    publicClient.readContract({ address: forwardingTable, abi: FORWARDING_TABLE_ABI, functionName: 'ROLLUP_VERSION' }),
    publicClient.getChainId(),
  ]);
  if (tableVersion !== rollupVersion) {
    return `the user record names rollup version ${rollupVersion}, but ${forwardingTable} serves ${tableVersion}`;
  }
  const payoutTokens = [
    ...new Set(
      tokens.map(
        token =>
          depositPayoutTokenFor(BigInt(chainId), EthAddress.fromString(token)).toString().toLowerCase() as Address,
      ),
    ),
  ];
  const rows = await Promise.all(
    payoutTokens.map(token => readForwardingTableRow(publicClient, forwardingTable, token, SipaIntent.Deposit)),
  );
  const portals = [...new Set(rows.flatMap(row => (row ? [row.portal.toLowerCase() as Address] : [])))];
  if (portals.length === 0) {
    return `${forwardingTable} lists no deposit of ${payoutTokens.join(', ')}`;
  }
  const reasons = await Promise.all(portals.map(portal => closedPortalReason(publicClient, portal)));
  if (reasons.includes(undefined)) {
    return undefined;
  }
  return reasons.join('; ');
}

/** Why `portal` takes no deposit, or undefined if it is open on the canonical rollup. */
async function closedPortalReason(publicClient: PublicClient, portal: Address): Promise<string | undefined> {
  const [frozen, rollup, registry] = await Promise.all([
    publicClient.readContract({ address: portal, abi: PORTAL_ABI, functionName: '$frozen' }),
    publicClient.readContract({ address: portal, abi: PORTAL_ABI, functionName: 'ROLLUP' }),
    publicClient.readContract({ address: portal, abi: PORTAL_ABI, functionName: 'REGISTRY' }),
  ]);
  if (frozen) {
    return `${portal} is frozen`;
  }
  const canonical = await publicClient.readContract({
    address: registry,
    abi: AZTEC_REGISTRY_ABI,
    functionName: 'getCanonicalRollup',
  });
  if (canonical.toLowerCase() !== rollup.toLowerCase()) {
    return `the rollup of ${portal} is no longer canonical`;
  }
  return undefined;
}
