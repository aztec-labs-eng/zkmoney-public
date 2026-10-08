import { EthAddress } from '@aztec/foundation/eth-address';

import { L1OperationCondition } from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, test } from '@jest/globals';
import { type Address, type Hex, decodeFunctionData, getAddress, keccak256, multicall3Abi } from 'viem';

import { DepositSubsidyAbi, SIPAAbi, SIPAFactoryAbi } from './artifacts.js';
import { encodeDepositIntentData } from './intent.js';
import { encodeLegacySipaDeploy } from './legacy_sipa.js';
import { SipaIntent } from './sipa_factory.js';
import {
  MULTICALL3_ADDRESS,
  buildSipaDeployAndSweepOperation,
  buildSipaSweepOperation,
  decodeSipaSweepOperation,
  decodeSubsidizedDeployAndSweep,
  encodeAggregate3,
  isContractDeployed,
} from './sipa_sweep_operation.js';

const SIPA = '0x1111111111111111111111111111111111111111' as Address;
const SIPA_FACTORY = '0x2222222222222222222222222222222222222222' as Address;
const DEPOSIT_SUBSIDY = '0x3333333333333333333333333333333333333333' as Address;
const EXECUTOR = '0x4444444444444444444444444444444444444444' as Address;
const TOKEN = '0x5555555555555555555555555555555555555555' as Address;
const IMPLEMENTATION = '0x6666666666666666666666666666666666666666' as Address;
const RECOVERY = `0x00${'77'.repeat(31)}` as Hex;
const INTENT_DATA = encodeDepositIntentData(`0x${'ab'.repeat(32)}`);
const INTENT_HASH = `0x${'cd'.repeat(32)}` as Hex;

const DEPLOY_ARGS = {
  implementation: IMPLEMENTATION,
  intentHash: INTENT_HASH,
  recoveryCommitment: RECOVERY,
  rollupVersion: 4n,
  resweepable: true,
};
const SWEEP_ARGS = { token: TOKEN, relayer: EXECUTOR, intentData: INTENT_DATA, proofs: '0x' as Hex };

const BASE = {
  sipa: SIPA,
  sweepArgs: SWEEP_ARGS,
  payoutToken: TOKEN,
  condition: L1OperationCondition.immediate(),
};

const DEPLOY_BASE = { ...BASE, sipaFactory: SIPA_FACTORY, intent: SipaIntent.Deposit, deployArgs: DEPLOY_ARGS };

function decodeAggregate3(calldata: Buffer) {
  const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: `0x${calldata.toString('hex')}` });
  expect(functionName).toBe('aggregate3');
  return args[0]!;
}

describe('buildSipaDeployAndSweepOperation', () => {
  test('deploys and sweeps an undeployed SIPA through the deposit subsidy in one call', () => {
    const operation = buildSipaDeployAndSweepOperation({ ...DEPLOY_BASE, depositSubsidy: DEPOSIT_SUBSIDY });
    expect(operation.target.toString().toLowerCase()).toBe(DEPOSIT_SUBSIDY);
    expect(operation.payoutToken.toString().toLowerCase()).toBe(TOKEN);
    expect(decodeFunctionData({ abi: DepositSubsidyAbi, data: `0x${operation.calldata.toString('hex')}` })).toEqual({
      functionName: 'deployAndSweepForSubsidy',
      args: [SipaIntent.Deposit, RECOVERY, true, TOKEN, EXECUTOR, INTENT_DATA, '0x'],
    });
  });

  test('batches a legacy deploy with the subsidized sweep through Multicall3', () => {
    const legacyDeployArgs = {
      implementation: IMPLEMENTATION,
      intentHash: INTENT_HASH,
      recoveryAddress: EXECUTOR,
      rollupVersion: 4n,
      resweepable: true,
    };
    const operation = buildSipaDeployAndSweepOperation({
      ...DEPLOY_BASE,
      deployArgs: legacyDeployArgs,
      depositSubsidy: DEPOSIT_SUBSIDY,
    });
    expect(operation.target.toString().toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase());
    const [deploy, sweep] = decodeAggregate3(operation.calldata);
    expect(deploy.target).toBe(SIPA_FACTORY);
    expect(deploy.allowFailure).toBe(true);
    expect(deploy.callData).toBe(encodeLegacySipaDeploy(legacyDeployArgs));
    expect(sweep.target).toBe(DEPOSIT_SUBSIDY);
    expect(sweep.allowFailure).toBe(false);
    expect(decodeFunctionData({ abi: DepositSubsidyAbi, data: sweep.callData })).toEqual({
      functionName: 'sweepForSubsidy',
      args: [SIPA, TOKEN, EXECUTOR, INTENT_DATA, '0x'],
    });
  });

  test("carries the caller's condition", () => {
    const condition = L1OperationCondition.balance(EthAddress.fromString(TOKEN), EthAddress.fromString(SIPA));
    const operation = buildSipaDeployAndSweepOperation({ ...DEPLOY_BASE, condition });
    expect(operation.condition).toEqual(condition);
  });

  test('sweeps the SIPA directly when no deposit subsidy is configured', () => {
    const operation = buildSipaDeployAndSweepOperation({ ...DEPLOY_BASE, multicall3: EXECUTOR });
    expect(operation.target.toString().toLowerCase()).toBe(EXECUTOR);
    const [deploy, sweep] = decodeAggregate3(operation.calldata);
    expect(deploy.target).toBe(SIPA_FACTORY);
    expect(deploy.allowFailure).toBe(true);
    expect(decodeFunctionData({ abi: SIPAFactoryAbi, data: deploy.callData })).toEqual({
      functionName: 'deploySIPA',
      args: [IMPLEMENTATION, INTENT_HASH, RECOVERY, 4n, true],
    });
    expect(sweep.target).toBe(SIPA);
    expect(decodeFunctionData({ abi: SIPAAbi, data: sweep.callData })).toEqual({
      functionName: 'sweep',
      args: [TOKEN, EXECUTOR, INTENT_DATA, '0x'],
    });
  });

  test('a deposit bundle stays far below the 2k broadcast tier capacity', () => {
    const operation = buildSipaDeployAndSweepOperation({ ...DEPLOY_BASE, depositSubsidy: DEPOSIT_SUBSIDY });
    // The 2k tier holds 67 fields of 31 bytes.
    expect(operation.calldata.length).toBeLessThan(67 * 31);
  });
});

describe('buildSipaSweepOperation', () => {
  test('sweeps a deployed SIPA through the deposit subsidy in one call', () => {
    const operation = buildSipaSweepOperation({ ...BASE, depositSubsidy: DEPOSIT_SUBSIDY });
    expect(operation.target.toString().toLowerCase()).toBe(DEPOSIT_SUBSIDY);
    expect(operation.payoutToken.toString().toLowerCase()).toBe(TOKEN);
    expect(decodeFunctionData({ abi: DepositSubsidyAbi, data: `0x${operation.calldata.toString('hex')}` })).toEqual({
      functionName: 'sweepForSubsidy',
      args: [SIPA, TOKEN, EXECUTOR, INTENT_DATA, '0x'],
    });
  });

  test("carries the caller's condition", () => {
    const condition = L1OperationCondition.balance(EthAddress.fromString(TOKEN), EthAddress.fromString(SIPA));
    const operation = buildSipaSweepOperation({ ...BASE, condition });
    expect(operation.condition).toEqual(condition);
  });

  test('sweeps the SIPA directly when no deposit subsidy is configured', () => {
    const operation = buildSipaSweepOperation(BASE);
    expect(operation.target.toString().toLowerCase()).toBe(SIPA);
    expect(decodeFunctionData({ abi: SIPAAbi, data: `0x${operation.calldata.toString('hex')}` })).toEqual({
      functionName: 'sweep',
      args: [TOKEN, EXECUTOR, INTENT_DATA, '0x'],
    });
  });
});

describe('isContractDeployed', () => {
  test('reads code presence off the client', async () => {
    const client = (code: Hex | undefined) => ({ getCode: () => Promise.resolve(code) }) as any;
    expect(await isContractDeployed(client('0x6001'), SIPA)).toBe(true);
    expect(await isContractDeployed(client('0x'), SIPA)).toBe(false);
    expect(await isContractDeployed(client(undefined), SIPA)).toBe(false);
  });
});

describe('encodeAggregate3', () => {
  test('round-trips its calls', () => {
    const calls = [
      { target: SIPA, allowFailure: false, callData: '0x01' as Hex },
      { target: EXECUTOR, allowFailure: true, callData: '0x0203' as Hex },
    ];
    const encoded = Buffer.from(encodeAggregate3(calls).slice(2), 'hex');
    expect(decodeAggregate3(encoded)).toEqual(calls);
  });
});

describe('decodeSipaSweepOperation', () => {
  test('reads the SIPA and the token of a direct sweep', () => {
    expect(decodeSipaSweepOperation(buildSipaSweepOperation(BASE))).toEqual({ sipa: SIPA, token: TOKEN });
  });

  test('reads the SIPA and the token of a subsidised sweep', () => {
    const operation = buildSipaSweepOperation({ ...BASE, depositSubsidy: DEPOSIT_SUBSIDY });
    expect(operation.target.toString().toLowerCase()).toBe(DEPOSIT_SUBSIDY);
    expect(decodeSipaSweepOperation(operation)).toEqual({ sipa: SIPA, token: TOKEN });
  });

  test('reads the sweep and the deploy call inside a deploy-and-sweep batch', () => {
    const deploy = { factory: SIPA_FACTORY, args: DEPLOY_ARGS };
    expect(decodeSipaSweepOperation(buildSipaDeployAndSweepOperation(DEPLOY_BASE))).toEqual({
      sipa: SIPA,
      token: TOKEN,
      deploy,
    });
  });

  test('leaves a subsidized deploy-and-sweep to decodeSubsidizedDeployAndSweep', () => {
    const operation = buildSipaDeployAndSweepOperation({ ...DEPLOY_BASE, depositSubsidy: DEPOSIT_SUBSIDY });
    expect(decodeSipaSweepOperation(operation)).toBeUndefined();
    expect(decodeSubsidizedDeployAndSweep(operation)).toEqual({
      depositSubsidy: getAddress(DEPOSIT_SUBSIDY),
      token: TOKEN,
      intent: SipaIntent.Deposit,
      intentHash: keccak256(INTENT_DATA),
      recoveryCommitment: DEPLOY_ARGS.recoveryCommitment,
      resweepable: DEPLOY_ARGS.resweepable,
    });
    expect(decodeSubsidizedDeployAndSweep(buildSipaDeployAndSweepOperation(DEPLOY_BASE))).toBeUndefined();
  });

  test('returns undefined for an operation that is not a sweep', () => {
    const foreign = {
      target: EthAddress.fromString(EXECUTOR),
      payoutToken: EthAddress.fromString(TOKEN),
      calldata: Buffer.from('a9059cbb' + '00'.repeat(64), 'hex'),
      condition: L1OperationCondition.immediate(),
    };
    expect(decodeSipaSweepOperation(foreign)).toBeUndefined();
    expect(decodeSipaSweepOperation({ ...foreign, calldata: Buffer.alloc(0) })).toBeUndefined();
  });
});
