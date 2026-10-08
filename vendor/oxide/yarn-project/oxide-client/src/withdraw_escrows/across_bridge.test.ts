import { AztecAddress, EthAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';

import { encodeAcrossBridgeEscrowDeploy, predictAcrossBridgeEscrowAddressLocally } from '@oxide/l1-contracts';
import { MAINNET_USDC, MAINNET_USDT } from '@oxide/l1-contracts/deposit_tokens.js';
import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { deriveRecoveryCommitment } from '@oxide/oxide-lib/sipa_recovery.js';

import { describe, expect, it } from '@jest/globals';

import type { AcrossFees } from './across_api.js';
import {
  type AcrossBridgeOnWithdrawArgs,
  type AcrossBridgeQuoteArgs,
  type AcrossBridgeRoute,
  acrossEvmDestination,
  buildAcrossBridgeOnWithdraw,
  quoteAcrossBridge,
} from './across_bridge.js';
import { fakeBroadcaster } from './test_helpers.js';

const DAI = 10n ** 18n;
const DAI_PER_INPUT_UNIT = 10n ** 12n;
/** What `bridgeArgs()` leaves at the escrow: 100 DAI less the 1 DAI withdrawal and prover tips. */
const ESCROW_FUNDING = 98n * DAI;
/** What `bridgeArgs()` deposits at the 1% swap floor: the escrow funding less the 3 DAI relayer tip, less 1%. */
const MIN_DEPOSIT = 94_050_000n;

const ROUTE: AcrossBridgeRoute = {
  acrossInputToken: EthAddress.fromString('0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  destinationChainId: 42_161n,
  acrossOutputToken: EthAddress.fromString('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'),
  acrossOutputTokenDecimals: 6,
};

describe('acrossEvmDestination', () => {
  it('routes the mainnet Across input token to the native token on the chain', () => {
    expect(acrossEvmDestination('USDT', 'bnb')).toEqual({
      acrossInputToken: MAINNET_USDT,
      destinationChainId: 56n,
      acrossOutputToken: EthAddress.fromString('0x55d398326f99059fF775485246999027B3197955'),
      acrossOutputTokenDecimals: 18,
    });
    expect(acrossEvmDestination('USDC', 'bnb')).toEqual({
      acrossInputToken: MAINNET_USDC,
      destinationChainId: 56n,
      acrossOutputToken: EthAddress.fromString('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'),
      acrossOutputTokenDecimals: 18,
    });
  });

  it('lists only the chains of the Across input token', () => {
    // @ts-expect-error Across has no USDC route to Plasma.
    expect(() => acrossEvmDestination('USDC', 'plasma')).toThrow('Across has no USDC route to plasma');
  });
});

describe('buildAcrossBridgeOnWithdraw', () => {
  it('commits the escrow to the route, the recipient, the fee, the nonce and the recovery salt', async () => {
    const args = await bridgeArgs();
    const nonce = Fr.random().toString();
    const recoverySalt = Fr.random();
    const route = { ...ROUTE, acrossOutputTokenDecimals: 18 };

    const bridge = buildAcrossBridgeOnWithdraw({ ...args, route, nonce, recoverySalt });

    expect(bridge.nonce).toBe(nonce);
    expect(bridge.recoverySalt).toEqual(recoverySalt);
    expect(bridge.escrowArgs).toEqual({
      acrossInputToken: ROUTE.acrossInputToken.toString(),
      destinationChainId: ROUTE.destinationChainId,
      recipient: args.recipient.toString(),
      acrossOutputToken: ROUTE.acrossOutputToken.toString(),
      acrossOutputTokenDecimals: 18,
      acrossFee: args.acrossFee,
      recoveryCommitment: deriveRecoveryCommitment(recoverySalt, args.recoveryAccount).toString(),
      relayerTip: args.relayerTip,
      nonce,
    });
    expect(bridge.escrow).toEqual(
      EthAddress.fromString(
        predictAcrossBridgeEscrowAddressLocally(args.acrossBridgeEscrowFactory.toString(), bridge.escrowArgs),
      ),
    );
  });

  it('returns the L1 operation that it broadcasts', async () => {
    const args = await bridgeArgs();

    const { escrow, escrowArgs, l1Operation } = buildAcrossBridgeOnWithdraw(args);

    expect(l1Operation.target.equals(args.acrossBridgeEscrowFactory)).toBe(true);
    expect(l1Operation.payoutToken.equals(args.dai)).toBe(true);
    expect(l1Operation.calldata).toEqual(Buffer.from(encodeAcrossBridgeEscrowDeploy(escrowArgs).slice(2), 'hex'));
    expect(l1Operation.condition).toEqual(L1OperationCondition.balance(args.dai, escrow));
  });

  it('rejects a relayer tip at the escrow funding before the deposit checks', async () => {
    const args = await bridgeArgs();

    expect(() => buildAcrossBridgeOnWithdraw({ ...args, relayerTip: ESCROW_FUNDING })).toThrow(
      `relayerTip (${ESCROW_FUNDING}) must be below the escrow funding of amount - proverTip - fpcFundingCut - withdrawalRelayerTip (${ESCROW_FUNDING})`,
    );
  });

  it('rejects a floor deposit at acrossFee', async () => {
    const args = await bridgeArgs();

    expect(() => buildAcrossBridgeOnWithdraw({ ...args, acrossFee: MIN_DEPOSIT - 1n })).not.toThrow();
    expect(() => buildAcrossBridgeOnWithdraw({ ...args, acrossFee: MIN_DEPOSIT })).toThrow(
      `the deposit at the swap floor (${MIN_DEPOSIT}) must be above acrossFee (${MIN_DEPOSIT}), or the escrow reverts`,
    );
  });

  it('rejects a Across output token with fewer decimals than the Across input token', async () => {
    const args = await bridgeArgs();

    expect(() => buildAcrossBridgeOnWithdraw({ ...args, route: { ...ROUTE, acrossOutputTokenDecimals: 5 } })).toThrow(
      'acrossOutputTokenDecimals (5) must be at least 6',
    );
  });

  it('rejects a deposit to the zero address', async () => {
    const args = await bridgeArgs();

    expect(() => buildAcrossBridgeOnWithdraw({ ...args, recipient: EthAddress.ZERO })).toThrow(
      'AcrossBridgeEscrowArgs: recipient must be nonzero',
    );
  });
});

describe('quoteAcrossBridge', () => {
  const fees: AcrossFees = {
    // 0.01% capital fee plus the gas fee's share of the quoted amount.
    totalRelayFeePct: 100_000_000_000_000n + 3_656_800_000_000n,
    relayerGasFeePct: 3_656_800_000_000n,
    relayerGasFee: 9_142n,
    acrossOutputTokenDecimals: 6,
    minDeposit: 500_013n,
    maxDeposit: 236_016_543_303n,
  };

  it('adds the percentage fees at a 1:1 swap, rounded up, to twice the gas fee', () => {
    expect(quoteAcrossBridge(quoteArgs(2_503n * DAI, 3n * DAI), fees).acrossFee).toBe(250_000n + 18_284n);
    expect(quoteAcrossBridge(quoteArgs(10_000_001n * DAI_PER_INPUT_UNIT), fees).acrossFee).toBe(1_001n + 18_284n);
  });

  it('receives the floor deposit less acrossFee, in Across output token units', () => {
    const args = { ...quoteArgs(100n * DAI, 1n * DAI), route: { ...ROUTE, acrossOutputTokenDecimals: 18 } };

    const quote = quoteAcrossBridge(args, { ...fees, acrossOutputTokenDecimals: 18 });

    expect(quote).toEqual({
      acrossFee: 9_900n + 18_284n,
      minReceived: (98_010_000n - 9_900n - 18_284n) * 10n ** 12n,
    });
  });

  it('funds the escrow with the withdrawal less the portal FPC funding cut', () => {
    const withCut = { ...quoteArgs(100n * DAI, 1n * DAI), fpcFundingCut: 1n * DAI };

    expect(quoteAcrossBridge(withCut, fees)).toEqual(quoteAcrossBridge(quoteArgs(99n * DAI, 1n * DAI), fees));
  });

  it('rejects route decimals that differ from the Across output token', () => {
    expect(() => quoteAcrossBridge(quoteArgs(1_000n * DAI), { ...fees, acrossOutputTokenDecimals: 18 })).toThrow(
      "the route's acrossOutputTokenDecimals (6) must match Across (18)",
    );
  });

  it('rejects a Across input token that is not USDC or USDT on Ethereum', () => {
    const args = { ...quoteArgs(1_000n * DAI), route: { ...ROUTE, acrossInputToken: ROUTE.acrossOutputToken } };

    expect(() => quoteAcrossBridge(args, fees)).toThrow(
      `the route's acrossInputToken (${ROUTE.acrossOutputToken}) must be USDC or USDT on Ethereum`,
    );
    expect(() =>
      quoteAcrossBridge({ ...args, route: { ...ROUTE, acrossInputToken: MAINNET_USDC } }, fees),
    ).not.toThrow();
  });

  it('accepts a 1:1 deposit at the Across maxDeposit and rejects one unit more', () => {
    const args = quoteArgs(1_000n * DAI);

    expect(() => quoteAcrossBridge(args, { ...fees, maxDeposit: 1_000_000_000n })).not.toThrow();
    expect(() => quoteAcrossBridge(args, { ...fees, maxDeposit: 999_999_999n })).toThrow(
      'the deposit (1000000000) is above the Across maxDeposit (999999999)',
    );
  });

  it('accepts a floor deposit at the Across minDeposit and rejects one unit less', () => {
    const args = quoteArgs(1_000n * DAI);

    expect(() => quoteAcrossBridge(args, { ...fees, minDeposit: 990_000_000n })).not.toThrow();
    expect(() => quoteAcrossBridge(args, { ...fees, minDeposit: 990_000_001n })).toThrow(
      'the deposit at the swap floor (990000000) is below the Across minDeposit (990000001)',
    );
  });

  it('rejects a acrossFee that the floor deposit does not cover', () => {
    expect(() => quoteAcrossBridge(quoteArgs(1n * DAI), { ...fees, minDeposit: 0n, relayerGasFee: 495_000n })).toThrow(
      'the deposit at the swap floor (990000) must be above acrossFee (990100), or the escrow reverts',
    );
  });
});

async function bridgeArgs(): Promise<AcrossBridgeOnWithdrawArgs> {
  return {
    broadcaster: fakeBroadcaster(),
    acrossBridgeEscrowFactory: EthAddress.random(),
    dai: EthAddress.random(),
    from: await AztecAddress.random(),
    plainWithdrawalExecutor: EthAddress.random(),
    amount: 100n * DAI,
    withdrawalRelayerTip: 1n * DAI,
    proverTip: 1n * DAI,
    fpcFundingCut: 0n,
    route: ROUTE,
    recipient: EthAddress.random(),
    acrossFee: 100_000n,
    recoveryAccount: EthAddress.random(),
    relayerTip: 3n * DAI,
  };
}

function quoteArgs(escrowFunding: bigint, relayerTip = 0n): AcrossBridgeQuoteArgs {
  return {
    amount: escrowFunding,
    withdrawalRelayerTip: 0n,
    proverTip: 0n,
    fpcFundingCut: 0n,
    relayerTip,
    route: ROUTE,
  };
}
