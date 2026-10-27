import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { type BroadcastL1Operation, L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, test } from '@jest/globals';
import { type Address, type Hex, encodeFunctionData, getAddress } from 'viem';

import { encodeAcrossBridgeEscrowDeploy } from './across_bridge_on_withdraw.js';
import { OxidePortalAbi } from './artifacts.js';
import { CctpBridgeRoute, encodeCctpBridgeEscrowDeploy } from './cctp_bridge_on_withdraw.js';
import { encodeDepositIntentData } from './intent.js';
import { LegacyFrozenDepositRefundAbi, classifyL1Operation } from './l1_operation_kind.js';
import { SipaIntent } from './sipa_factory.js';
import { buildSipaDeployAndSweepOperation, buildSipaSweepOperation } from './sipa_sweep_operation.js';
import { SwapRoute, encodeLegacySwapEscrowDeploy, encodeSwapEscrowDeploy } from './swap_on_withdraw.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x5555555555555555555555555555555555555555' as Address;
const BYTES32 = `0x${'22'.repeat(32)}` as Hex;
const RECOVERY = `0x00${'77'.repeat(31)}` as Hex;
const BALANCE = L1OperationCondition.balance(EthAddress.fromString(TOKEN), EthAddress.fromString(ADDRESS));

const SWEEP = {
  sipa: ADDRESS,
  sweepArgs: { token: TOKEN, relayer: ADDRESS, intentData: encodeDepositIntentData(BYTES32), proofs: '0x' as Hex },
  payoutToken: TOKEN,
  condition: BALANCE,
};
const DEPLOY_ARGS = {
  implementation: ADDRESS,
  intentHash: BYTES32,
  recoveryCommitment: RECOVERY,
  rollupVersion: 4n,
  resweepable: true,
  forwardingTable: getAddress(ADDRESS),
};
const DEPLOY_SWEEP = { ...SWEEP, sipaFactory: ADDRESS, deployArgs: DEPLOY_ARGS };
const EXECUTOR_CALL = { executor: ADDRESS, userPayload: '0x' as Hex, relayerPayload: '0x' as Hex, amount: 1n };

function operation(calldata: Hex, condition = L1OperationCondition.immediate()): BroadcastL1Operation {
  return {
    target: EthAddress.fromString(ADDRESS),
    payoutToken: EthAddress.fromString(TOKEN),
    calldata: Buffer.from(calldata.slice(2), 'hex'),
    condition,
  };
}

const SWAP_ESCROW = { route: SwapRoute.USDC, recipient: ADDRESS, recoveryCommitment: RECOVERY, relayerTip: 1n };
const BRIDGE_ESCROW = { recipient: ADDRESS, recoveryCommitment: RECOVERY, relayerTip: 1n, nonce: BYTES32 };
const CCTP = encodeCctpBridgeEscrowDeploy({
  ...BRIDGE_ESCROW,
  route: CctpBridgeRoute.Direct,
  destinationDomain: 3,
  minFinalityThreshold: 2000,
  maxFee: 0n,
});
const ACROSS = encodeAcrossBridgeEscrowDeploy({
  ...BRIDGE_ESCROW,
  acrossInputToken: TOKEN,
  destinationChainId: 10n,
  acrossOutputToken: TOKEN,
  acrossOutputTokenDecimals: 6,
  acrossFee: 0n,
});

describe('classifyL1Operation', () => {
  test.each([
    ['refundFrozenNotes', { ...EXECUTOR_CALL, nullifiers: [BYTES32], proof: '0x', teeSignature: '0x' }],
    ['refundFrozenDeposits', { ...EXECUTOR_CALL, nullifiers: [BYTES32], proof: '0x', teeSignature: '0x' }],
    [
      'refundUnprocessedDeposit',
      {
        ...EXECUTOR_CALL,
        siloedNullifier: BYTES32,
        messageHash: BYTES32,
        messageLeafIndex: 3n,
        proof: '0x',
        teeSignature: '0x',
      },
    ],
  ] as const)('classifies %s as a refund', (functionName, args) => {
    const calldata = encodeFunctionData({ abi: OxidePortalAbi, functionName, args: [args] } as never);
    expect(classifyL1Operation(operation(calldata))).toBe('refund');
  });

  // A frozen portal from before batched refunds takes one nullifier, so its refund has another selector.
  test('classifies a single-deposit refundFrozenDeposit of an older portal as a refund', () => {
    const calldata = encodeFunctionData({
      abi: LegacyFrozenDepositRefundAbi,
      functionName: 'refundFrozenDeposit',
      args: [{ ...EXECUTOR_CALL, siloedNullifier: BYTES32, proof: '0x', teeSignature: '0x' }],
    });
    expect(calldata.slice(0, 10)).toBe('0x998b1475');
    expect(classifyL1Operation(operation(calldata))).toBe('refund');
  });

  test.each([
    [
      'a MessageInOutbox operation',
      'withdrawal_finalization',
      operation('0xab', L1OperationCondition.messageInOutbox()),
    ],
    [
      'a subsidized deposit deploy-and-sweep',
      'sweep',
      buildSipaDeployAndSweepOperation({ ...DEPLOY_SWEEP, intent: SipaIntent.Deposit, depositSubsidy: ADDRESS }),
    ],
    [
      'a Multicall3 deposit deploy-and-sweep',
      'sweep',
      buildSipaDeployAndSweepOperation({ ...DEPLOY_SWEEP, intent: SipaIntent.Deposit }),
    ],
    ['a direct sweep', 'sweep', buildSipaSweepOperation(SWEEP)],
    ['a subsidized sweep', 'sweep', buildSipaSweepOperation({ ...SWEEP, depositSubsidy: ADDRESS })],
    [
      'a swap escrow deploy',
      'swap',
      operation(encodeSwapEscrowDeploy({ ...SWAP_ESCROW, daiForGas: 0n, minEthForGas: 0n, nonce: BYTES32 }), BALANCE),
    ],
    [
      'a legacy swap escrow deploy',
      'swap',
      operation(encodeLegacySwapEscrowDeploy({ ...SWAP_ESCROW, nonce: BYTES32 }), BALANCE),
    ],
    ['a CCTP bridge escrow deploy', 'bridge', operation(CCTP, BALANCE)],
    ['an Across bridge escrow deploy', 'bridge', operation(ACROSS, BALANCE)],
    ['empty calldata', 'other', operation('0x')],
    ['unknown calldata', 'other', operation('0xdeadbeef00', BALANCE)],
  ])('classifies %s as %s', (_, kind, op) => {
    expect(classifyL1Operation(op)).toBe(kind);
  });
});
