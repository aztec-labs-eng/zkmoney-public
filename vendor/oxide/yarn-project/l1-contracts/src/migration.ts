// Wallet helpers for the migration feature: `MigrationExecutor` and the `MigrationSubsidy` that it creates.
// Bindings-free: a wallet can import this module without the Noir contract bindings.
import { MAX_PRIORITY_FEE_WEI } from '@oxide/oxide-lib/oxide_constants.gen.js';

import { type Address, type Hex, type PublicClient, parseAbi, parseAbiItem } from 'viem';

import { MigrationSubsidyAbi } from './artifacts.js';

/** The flows of `IExecutor.Flow`, in the order of the Solidity enum. */
export const MigrationFlow = {
  Withdrawal: 0,
  FrozenNotesRefund: 1,
  FrozenDepositsRefund: 2,
  UnprocessedDepositRefund: 3,
} as const;
export type MigrationFlow = (typeof MigrationFlow)[keyof typeof MigrationFlow];

const MIGRATION_PROJECT = 'migration';

/** The age after which the subsidy ignores a price feed answer: `EthUsdMinOutLib.MAX_PRICE_AGE`. */
export const MIGRATION_SUBSIDY_MAX_PRICE_AGE_SECONDS = 3900n;

const MIGRATED = parseAbiItem(
  'event Migrated(uint8 flow, bytes32 indexed recipientCommitment, uint256 migrated, address tipRecipient, uint256 relayerTip)',
);

const AGGREGATOR_ABI = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
]);

const FROZEN_ABI = parseAbi(['function $frozen() view returns (bool)']);

const BALANCE_OF_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** One feature of a deployment entry in the manifest (`deployments[i].features[<id>]`). */
export interface DeploymentFeature {
  project: string;
  bridges: Record<string, string>;
  contracts: Record<string, string>;
  variables?: Record<string, string | number | boolean>;
}

/** The migration feature that serves one old portal. */
export interface MigrationFeature {
  /** The feature id, the key in `features`. */
  id: string;
  /** The `MigrationExecutor`. The withdrawal or refund of the old portal names it as executor. */
  executor: Address;
  /** The `MigrationSubsidy`. The L1 operation targets it. */
  subsidy: Address;
  /** The token that the subsidy pays the relayer in. It is the payout token of the L1 operation. */
  payoutToken: Address;
  /** The bridge id of the new portal (role `destination`). */
  destinationBridge: string;
}

/**
 * Find the migration feature of the old portal `sourcePortal` in the `features` of a deployment entry: the feature with
 * project `migration` and `variables.sourcePortal` equal to `sourcePortal`. The address compare ignores case. Returns
 * `undefined` when no feature matches. Throws when more than one feature matches, or when the matching feature does
 * not have all of its contracts, variables and bridges.
 */
export function findMigrationFeature(
  features: Record<string, DeploymentFeature> | undefined,
  sourcePortal: Address,
): MigrationFeature | undefined {
  const matches = Object.entries(features ?? {}).filter(([, feature]) => {
    const source = feature.project === MIGRATION_PROJECT ? feature.variables?.sourcePortal : undefined;
    return typeof source === 'string' && source.toLowerCase() === sourcePortal.toLowerCase();
  });
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length > 1) {
    throw new Error(
      `More than one migration feature serves the portal ${sourcePortal}: ${matches.map(([id]) => id).join(', ')}.`,
    );
  }
  const [id, feature] = matches[0];
  const executor = feature.contracts.migrationExecutor;
  const subsidy = feature.contracts.migrationExecutorSubsidy;
  const payoutToken = feature.variables?.payoutToken;
  const destinationBridge = feature.bridges.destination;
  if (!executor || !subsidy || typeof payoutToken !== 'string' || !destinationBridge) {
    throw new Error(
      `Migration feature ${id} must have contracts.migrationExecutor, contracts.migrationExecutorSubsidy, variables.payoutToken and bridges.destination.`,
    );
  }
  return {
    id,
    executor: executor as Address,
    subsidy: subsidy as Address,
    payoutToken: payoutToken as Address,
    destinationBridge,
  };
}

/** The values of a `MigrationSubsidy` that never change: its immutables and constants, and the decimals of its feed. */
export interface MigrationSubsidyTerms {
  subsidy: Address;
  /** The token that the subsidy pays in. */
  token: Address;
  tokenDecimals: number;
  sourcePortal: Address;
  destinationPortal: Address;
  executor: Address;
  /** The subsidy pays only a caller that has this code hash. */
  operationExecutorCodeHash: Hex;
  /** The maximum gas that the subsidy prices for each flow, before the fresh-balance gas. */
  gasCeilings: { withdrawal: bigint; frozenNotes: bigint; frozenDeposits: bigint; unprocessedDeposit: bigint };
  /** The gas that the subsidy adds to the ceiling when the relayer has no token balance. */
  freshBalanceGas: bigint;
  /** The ETH/USD feed of the subsidy. */
  priceFeed: { address: Address; decimals: number };
}

/** The values of a `MigrationSubsidy` that change: read them before each check. */
export interface MigrationSubsidyState {
  /** The token balance of the subsidy. The subsidy pays at most this balance. */
  balance: bigint;
  config: { targetRelayerProfit: bigint; maxSubsidyPerOperation: bigint; minMigratedAmount: bigint };
  /** The subsidy pays only when the old portal is frozen. */
  sourceFrozen: boolean;
  /** The latest answer of the feed. */
  priceFeed: { answer: bigint; updatedAt: bigint };
}

/** The state of a `MigrationSubsidy` that decides how much it pays the relayer of a migration: its terms and its state. */
export type MigrationSubsidyStatus = Omit<MigrationSubsidyTerms, 'priceFeed'> &
  Omit<MigrationSubsidyState, 'priceFeed'> & {
    priceFeed: MigrationSubsidyTerms['priceFeed'] & MigrationSubsidyState['priceFeed'];
  };

/** A client that can batch reads into one `eth_call` through Multicall3. */
type MulticallClient = Pick<PublicClient, 'readContract'> & Partial<Pick<PublicClient, 'multicall'>>;

/** Read the terms of the `MigrationSubsidy` at `subsidy`. They never change, so read them one time. */
export async function readMigrationSubsidyTerms(
  publicClient: Pick<PublicClient, 'readContract'>,
  subsidy: Address,
): Promise<MigrationSubsidyTerms> {
  const contract = { address: subsidy, abi: MigrationSubsidyAbi } as const;
  const ceiling = (flow: MigrationFlow) =>
    publicClient.readContract({ ...contract, functionName: 'migrationGasCeiling', args: [flow] });
  const [
    token,
    tokenDecimals,
    sourcePortal,
    destinationPortal,
    executor,
    operationExecutorCodeHash,
    withdrawal,
    frozenNotes,
    frozenDeposits,
    unprocessedDeposit,
    freshBalanceGas,
    priceFeed,
  ] = await Promise.all([
    publicClient.readContract({ ...contract, functionName: 'TOKEN' }),
    publicClient.readContract({ ...contract, functionName: 'TOKEN_DECIMALS' }),
    publicClient.readContract({ ...contract, functionName: 'SOURCE_PORTAL' }),
    publicClient.readContract({ ...contract, functionName: 'DESTINATION_PORTAL' }),
    publicClient.readContract({ ...contract, functionName: 'EXECUTOR' }),
    publicClient.readContract({ ...contract, functionName: 'OPERATION_EXECUTOR_CODEHASH' }),
    ceiling(MigrationFlow.Withdrawal),
    ceiling(MigrationFlow.FrozenNotesRefund),
    ceiling(MigrationFlow.FrozenDepositsRefund),
    ceiling(MigrationFlow.UnprocessedDepositRefund),
    publicClient.readContract({ ...contract, functionName: 'FRESH_BALANCE_GAS' }),
    publicClient.readContract({ ...contract, functionName: 'PRICE_FEED' }),
  ]);
  const feedDecimals = await publicClient.readContract({
    address: priceFeed,
    abi: AGGREGATOR_ABI,
    functionName: 'decimals',
  });
  return {
    subsidy,
    token,
    tokenDecimals: Number(tokenDecimals),
    sourcePortal,
    destinationPortal,
    executor,
    operationExecutorCodeHash,
    gasCeilings: { withdrawal, frozenNotes, frozenDeposits, unprocessedDeposit },
    freshBalanceGas,
    priceFeed: { address: priceFeed, decimals: Number(feedDecimals) },
  };
}

/**
 * Read the state of a `MigrationSubsidy` whose terms are known: four reads, batched into one `eth_call` when the
 * client has `multicall`.
 */
export async function readMigrationSubsidyState(
  publicClient: MulticallClient,
  terms: Pick<MigrationSubsidyTerms, 'subsidy' | 'token' | 'sourcePortal' | 'priceFeed'>,
): Promise<MigrationSubsidyState> {
  const contracts = [
    { address: terms.token, abi: BALANCE_OF_ABI, functionName: 'balanceOf', args: [terms.subsidy] },
    { address: terms.subsidy, abi: MigrationSubsidyAbi, functionName: '$config' },
    { address: terms.sourcePortal, abi: FROZEN_ABI, functionName: '$frozen' },
    { address: terms.priceFeed.address, abi: AGGREGATOR_ABI, functionName: 'latestRoundData' },
  ] as const;
  const [balance, config, sourceFrozen, round] = publicClient.multicall
    ? await publicClient.multicall({ contracts, allowFailure: false })
    : await Promise.all(contracts.map(request => publicClient.readContract(request as never)));
  const [targetRelayerProfit, maxSubsidyPerOperation, minMigratedAmount] = config as readonly [bigint, bigint, bigint];
  const feedRound = round as readonly [bigint, bigint, bigint, bigint, bigint];
  return {
    balance: balance as bigint,
    config: { targetRelayerProfit, maxSubsidyPerOperation, minMigratedAmount },
    sourceFrozen: sourceFrozen as boolean,
    priceFeed: { answer: feedRound[1], updatedAt: feedRound[3] },
  };
}

/** The terms and the state of a `MigrationSubsidy` in one value. */
export function migrationSubsidyStatus(
  terms: MigrationSubsidyTerms,
  state: MigrationSubsidyState,
): MigrationSubsidyStatus {
  return { ...terms, ...state, priceFeed: { ...terms.priceFeed, ...state.priceFeed } };
}

/**
 * Read the terms and the state of the `MigrationSubsidy` at `subsidy`. A wallet reads the terms one time with
 * `readMigrationSubsidyTerms`, then the state before each check with `readMigrationSubsidyState`.
 */
export async function readMigrationSubsidyStatus(
  publicClient: MulticallClient,
  subsidy: Address,
): Promise<MigrationSubsidyStatus> {
  const terms = await readMigrationSubsidyTerms(publicClient, subsidy);
  return migrationSubsidyStatus(terms, await readMigrationSubsidyState(publicClient, terms));
}

/** The inputs of `estimateMigrationSubsidy`. */
export interface MigrationSubsidyEstimateArgs {
  flow: MigrationFlow;
  /** The gas price of the relayer transaction. */
  gasPriceWei: bigint;
  /**
   * The base fee of the block. When set, the gas price is capped at the base fee plus `MAX_PRIORITY_FEE_WEI`, as the
   * subsidy does.
   */
  baseFeeWei?: bigint;
  /** The ETH price in USD. When not set, the latest answer of the subsidy's price feed is used. */
  usdPerEth?: number;
}

/**
 * An upper bound of the payout, in token wei, that the subsidy makes for one migration of `flow`. It uses the
 * formula of the subsidy: `min(gas × gasPrice × tokenWeiPerEth / 1e18 + targetRelayerProfit, maxSubsidyPerOperation)`,
 * with the gas at the flow's ceiling plus the fresh-balance gas. The subsidy meters the real transaction, so it
 * usually pays less. The subsidy also pays at most its balance; this estimate ignores the balance. Returns 0 when the
 * subsidy pays nothing at this price (a zero or negative ETH price).
 */
export function estimateMigrationSubsidy(status: MigrationSubsidyStatus, args: MigrationSubsidyEstimateArgs): bigint {
  const gas = migrationGasCeilingOf(status, args.flow) + status.freshBalanceGas;
  const tokenPerEth = tokenWeiPerEth(status, args.usdPerEth);
  if (gas === 0n || tokenPerEth === 0n) {
    return 0n;
  }
  const gasPrice =
    args.baseFeeWei === undefined ? args.gasPriceWei : min(args.gasPriceWei, args.baseFeeWei + MAX_PRIORITY_FEE_WEI);
  const gasCost = (gas * gasPrice * tokenPerEth) / 10n ** 18n;
  return min(gasCost + status.config.targetRelayerProfit, status.config.maxSubsidyPerOperation);
}

/**
 * The inputs of `canMigrate`. The estimate uses the latest answer of the subsidy's price feed, as the subsidy does;
 * a caller cannot replace it here.
 */
export interface CanMigrateArgs extends Omit<MigrationSubsidyEstimateArgs, 'usdPerEth'> {
  /** The amount that the executor deposits into the new portal (see `migratedAmount`). */
  migratedAmount: bigint;
  /** The current time in seconds, to check the age of the price feed answer as the subsidy does. */
  nowSeconds: bigint;
}

/**
 * Whether the subsidy pays the relayer of a migration. `reasons` lists each reason that it does not pay, or that it
 * can pay less than the estimate. A migration also succeeds without a subsidy, but a relayer then gets no payment and
 * possibly does not run it.
 */
export function canMigrate(status: MigrationSubsidyStatus, args: CanMigrateArgs): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!status.sourceFrozen) {
    reasons.push('The old portal is not frozen, so the subsidy pays nothing.');
  }
  if (args.migratedAmount < status.config.minMigratedAmount) {
    reasons.push(
      `The migrated amount ${args.migratedAmount} is below the subsidy minimum ${status.config.minMigratedAmount}.`,
    );
  }
  if (status.priceFeed.updatedAt > args.nowSeconds) {
    reasons.push('The price feed answer is dated in the future, so the subsidy pays nothing.');
  } else if (args.nowSeconds - status.priceFeed.updatedAt > MIGRATION_SUBSIDY_MAX_PRICE_AGE_SECONDS) {
    reasons.push('The price feed answer is stale, so the subsidy pays nothing.');
  }
  const { flow, gasPriceWei, baseFeeWei } = args;
  const payout = estimateMigrationSubsidy(status, { flow, gasPriceWei, baseFeeWei });
  if (payout === 0n) {
    reasons.push('The subsidy pays nothing: its config or the ETH price is zero.');
  } else if (status.balance < payout) {
    reasons.push(`The subsidy balance ${status.balance} is below the estimated payout ${payout}.`);
  }
  return { ok: reasons.length === 0, reasons };
}

/** One `Migrated` event of a `MigrationExecutor`. */
export interface MigrationExecution {
  txHash: Hex;
  blockNumber: bigint;
  flow: MigrationFlow;
  /** The amount that the executor deposited into the new portal. */
  migrated: bigint;
  relayerTip: bigint;
}

/**
 * The migration that deposited under `recipientCommitment`, from the `Migrated` events of `executor`. `toBlock`
 * defaults to the latest block. Returns the first match, or `undefined` when there is none.
 */
export async function findMigrationExecution(
  publicClient: Pick<PublicClient, 'getLogs'>,
  executor: Address,
  recipientCommitment: Hex,
  fromBlock: bigint,
  toBlock?: bigint,
): Promise<MigrationExecution | undefined> {
  const [log] = await publicClient.getLogs({
    address: executor,
    event: MIGRATED,
    args: { recipientCommitment },
    fromBlock,
    toBlock,
  });
  if (!log || log.transactionHash === null || log.blockNumber === null) {
    return undefined;
  }
  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    flow: Number(log.args.flow) as MigrationFlow,
    migrated: log.args.migrated!,
    relayerTip: log.args.relayerTip!,
  };
}

function migrationGasCeilingOf(status: MigrationSubsidyStatus, flow: MigrationFlow): bigint {
  switch (flow) {
    case MigrationFlow.Withdrawal:
      return status.gasCeilings.withdrawal;
    case MigrationFlow.FrozenNotesRefund:
      return status.gasCeilings.frozenNotes;
    case MigrationFlow.FrozenDepositsRefund:
      return status.gasCeilings.frozenDeposits;
    default:
      return status.gasCeilings.unprocessedDeposit;
  }
}

/** The token wei that one ETH buys: `MigrationSubsidy._tokenWeiPerEth`, without the age check. */
function tokenWeiPerEth(status: MigrationSubsidyStatus, usdPerEth: number | undefined): bigint {
  const usd = 10n ** BigInt(status.tokenDecimals);
  if (usdPerEth !== undefined) {
    if (!Number.isFinite(usdPerEth) || usdPerEth <= 0) {
      return 0n;
    }
    const PRICE_DECIMALS = 8;
    return (BigInt(Math.round(usdPerEth * 10 ** PRICE_DECIMALS)) * usd) / 10n ** BigInt(PRICE_DECIMALS);
  }
  const { answer, decimals } = status.priceFeed;
  if (answer < 0n) {
    return 0n;
  }
  return (answer * usd) / 10n ** BigInt(decimals);
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
