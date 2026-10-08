import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';

import {
  CctpBridgeRoute,
  CctpFinality,
  encodeCctpBridgeEscrowDeploy,
  predictCctpBridgeEscrowAddressLocally,
} from '@oxide/l1-contracts';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import type { CctpFee } from './cctp_api.js';
import {
  type CctpBridgeOnWithdrawArgs,
  type CctpBridgeQuoteArgs,
  HYPERCORE_ACCOUNT_ACTIVATION_FEE,
  buildCctpBridgeOnWithdraw,
  cctpEvmDestination,
  hyperCoreDestination,
  quoteCctpBridge,
} from './cctp_bridge.js';
import { fakeBroadcaster } from './test_helpers.js';

const DAI = 10n ** 18n;
const DAI_PER_USDC_UNIT = 10n ** 12n;
/** What `bridgeArgs()` leaves at the escrow: 100 DAI less the 1 DAI withdrawal and prover tips. */
const ESCROW_FUNDING = 98n * DAI;
/** What `bridgeArgs()` burns at the 1% swap floor: the escrow funding less the 3 DAI relayer tip, less 1%. */
const MIN_BURN = 94_050_000n;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildCctpBridgeOnWithdraw', () => {
  it('commits the escrow to the destination, the CCTP parameters, the nonce and the recovery salt', async () => {
    const args = await bridgeArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();

    const bridge = buildCctpBridgeOnWithdraw({
      ...args,
      destination: await hyperCore({ accountExists: true }),
      nonce,
      recoverySalt,
    });

    expect(bridge.nonce).toBe(nonce);
    expect(bridge.recoverySalt).toEqual(recoverySalt);
    expect(bridge.escrowArgs).toEqual({
      route: CctpBridgeRoute.HyperCoreSpot,
      destinationDomain: 19,
      recipient: args.recipient.toString(),
      minFinalityThreshold: CctpFinality.Fast,
      maxFee: args.maxFee,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
      relayerTip: args.relayerTip,
      nonce,
    });
    expect(bridge.escrow).toEqual(
      EthAddress.fromString(
        predictCctpBridgeEscrowAddressLocally(args.cctpBridgeEscrowFactory.toString(), bridge.escrowArgs),
      ),
    );
  });

  it('returns the L1 operation that it broadcasts', async () => {
    const args = await bridgeArgs();

    const { escrow, escrowArgs, l1Operation } = buildCctpBridgeOnWithdraw(args);

    expect(l1Operation.target.equals(args.cctpBridgeEscrowFactory)).toBe(true);
    expect(l1Operation.payoutToken.equals(args.dai)).toBe(true);
    expect(l1Operation.calldata).toEqual(Buffer.from(encodeCctpBridgeEscrowDeploy(escrowArgs).slice(2), 'hex'));
    expect(l1Operation.condition).toEqual(L1OperationCondition.balance(args.dai, escrow));
  });

  it('rejects a relayer tip at the escrow funding before the burn checks', async () => {
    const args = await bridgeArgs();

    expect(() => buildCctpBridgeOnWithdraw({ ...args, relayerTip: ESCROW_FUNDING })).toThrow(
      `relayerTip (${ESCROW_FUNDING}) must be below the escrow funding of amount - proverTip - fpcFundingCut - withdrawalRelayerTip (${ESCROW_FUNDING})`,
    );
  });

  it('accepts exactly the destination minimum and rejects one unit less', async () => {
    const args = await bridgeArgs();
    const { minReceived } = cctpEvmDestination('base');
    const maxFee = MIN_BURN - minReceived;

    expect(() => buildCctpBridgeOnWithdraw({ ...args, maxFee })).not.toThrow();
    expect(() => buildCctpBridgeOnWithdraw({ ...args, maxFee: maxFee + 1n })).toThrow(
      `base needs at least ${minReceived} USDC units to arrive, but at the swap floor, ` +
        `after a maxFee of ${maxFee + 1n} and a delivery fee of 0, only ${minReceived - 1n} would`,
    );
  });

  it('rejects a floor burn at maxFee even when the destination has no minimum', async () => {
    const args = await bridgeArgs();
    const destination = { ...cctpEvmDestination('base'), minReceived: 0n };

    expect(() => buildCctpBridgeOnWithdraw({ ...args, destination, maxFee: MIN_BURN - 1n })).not.toThrow();
    expect(() => buildCctpBridgeOnWithdraw({ ...args, destination, maxFee: MIN_BURN })).toThrow(
      `the burn at the swap floor (${MIN_BURN}) must be above maxFee (${MIN_BURN}), or the escrow reverts`,
    );
  });

  it('rejects a burn to the zero address on either route', async () => {
    const args = await bridgeArgs();
    const hyperCoreDestination = await hyperCore({ accountExists: true });

    expect(() => buildCctpBridgeOnWithdraw({ ...args, recipient: EthAddress.ZERO })).toThrow(
      'CctpBridgeEscrowArgs: recipient must be nonzero',
    );
    expect(() =>
      buildCctpBridgeOnWithdraw({
        ...args,
        destination: hyperCoreDestination,
        recipient: EthAddress.ZERO,
      }),
    ).toThrow('CctpBridgeEscrowArgs: recipient must be nonzero');
  });

  it('rejects a HyperCoreSpot burn off the HyperEVM domain and an unknown route', async () => {
    const args = await bridgeArgs();
    const base = cctpEvmDestination('base');
    const hyperCoreDestination = await hyperCore({ accountExists: true });

    expect(() =>
      buildCctpBridgeOnWithdraw({
        ...args,
        destination: { ...hyperCoreDestination, domain: base.domain },
      }),
    ).toThrow('CctpBridgeEscrowArgs: HyperCoreSpot must burn to domain 19');
    expect(() => buildCctpBridgeOnWithdraw({ ...args, destination: { ...base, route: 2 as CctpBridgeRoute } })).toThrow(
      'CctpBridgeEscrowArgs: unknown route 2',
    );
  });
});

describe('quoteCctpBridge', () => {
  const forwardFee = { low: 1n, med: 2n, high: 135_797n };
  const fast: CctpFee = { finalityThreshold: CctpFinality.Fast, minimumFee: 1, forwardFee };
  const standard: CctpFee = { finalityThreshold: CctpFinality.Standard, minimumFee: 0, forwardFee };

  it('adds the protocol fee at the best-case burn, rounded up, to the high forwarding fee', () => {
    expect(quoteCctpBridge(quoteArgs(2_503n * DAI, 3n * DAI), [fast]).maxFee).toBe(250_000n + 135_797n);
    expect(quoteCctpBridge(quoteArgs(10_000_001n * DAI_PER_USDC_UNIT), [fast]).maxFee).toBe(1_001n + 135_797n);
  });

  it('keeps a fractional basis point fee without float rounding it up', () => {
    const args = quoteArgs(10_000n * DAI);

    expect(quoteCctpBridge(args, [{ ...fast, minimumFee: 1.3 }]).maxFee).toBe(1_300_000n + 135_797n);
    expect(quoteCctpBridge(args, [{ ...fast, minimumFee: 1.1 }]).maxFee).toBe(1_100_000n + 135_797n);
  });

  it('prices the entry at the escrow finality', () => {
    const args = quoteArgs(10_000n * DAI);

    expect(quoteCctpBridge(args, [standard, fast]).maxFee).toBe(1_000_000n + 135_797n);
    expect(quoteCctpBridge({ ...args, minFinalityThreshold: CctpFinality.Standard }, [standard, fast]).maxFee).toBe(
      135_797n,
    );
  });

  it('rejects a finality with no forwarding fee', () => {
    const args = quoteArgs(10_000n * DAI);

    expect(() => quoteCctpBridge(args, [standard])).toThrow('CCTP fees have no forwardFee at finality 1000');
    expect(() => quoteCctpBridge(args, [{ ...fast, forwardFee: undefined }, standard])).toThrow(
      'CCTP fees have no forwardFee at finality 1000',
    );
  });

  it('receives at least the DAI after the tip at the 1% swap floor, less maxFee', () => {
    expect(quoteCctpBridge(quoteArgs(100n * DAI, 1n * DAI), [fast])).toEqual({
      maxFee: 9_900n + 135_797n,
      minReceived: 98_010_000n - 9_900n - 135_797n,
    });
  });

  it('subtracts the activation fee of a new HyperCore account', async () => {
    const existing = quoteCctpBridge(quoteArgs(100n * DAI, 1n * DAI, await hyperCore({ accountExists: true })), [fast]);
    const created = quoteCctpBridge(quoteArgs(100n * DAI, 1n * DAI, await hyperCore({ accountExists: false })), [fast]);

    expect(existing.minReceived).toBe(98_010_000n - 9_900n - 135_797n);
    expect(created).toEqual({ ...existing, minReceived: existing.minReceived - HYPERCORE_ACCOUNT_ACTIVATION_FEE });
  });

  it('rejects an amount that the activation fee pushes below the destination minimum', async () => {
    const existing = await hyperCore({ accountExists: true });
    const created = await hyperCore({ accountExists: false });

    expect(quoteCctpBridge(quoteArgs(2n * DAI, 0n, existing), [fast]).minReceived).toBe(1_844_003n);
    expect(() => quoteCctpBridge(quoteArgs(2n * DAI, 0n, created), [fast])).toThrow(
      'HyperCore needs at least 1000000 USDC units to arrive, but at the swap floor, ' +
        'after a maxFee of 135997 and a delivery fee of 1000000, only 844003 would',
    );
  });
});

/** Answers the Hyperliquid account lookup of `hyperCoreDestination`. */
function hyperCore({ accountExists }: { accountExists: boolean }) {
  const role = accountExists ? 'user' : 'missing';
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ role })));
  return hyperCoreDestination(EthAddress.random());
}

async function bridgeArgs(): Promise<CctpBridgeOnWithdrawArgs> {
  return {
    broadcaster: fakeBroadcaster(),
    cctpBridgeEscrowFactory: EthAddress.random(),
    dai: EthAddress.random(),
    from: await AztecAddress.random(),
    plainWithdrawalExecutor: EthAddress.random(),
    amount: 100n * DAI,
    withdrawalRelayerTip: 1n * DAI,
    proverTip: 1n * DAI,
    fpcFundingCut: 0n,
    destination: cctpEvmDestination('base'),
    recipient: EthAddress.random(),
    minFinalityThreshold: CctpFinality.Fast,
    maxFee: 100_000n,
    recoveryAccount: EthAddress.random(),
    relayerTip: 3n * DAI,
  };
}

function quoteArgs(
  escrowFunding: bigint,
  relayerTip = 0n,
  destination = cctpEvmDestination('base'),
): CctpBridgeQuoteArgs {
  return {
    amount: escrowFunding,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip,
    minFinalityThreshold: CctpFinality.Fast,
    destination,
  };
}
