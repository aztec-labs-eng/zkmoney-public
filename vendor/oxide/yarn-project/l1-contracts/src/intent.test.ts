import {
  L1OperationCondition,
  L1_OPERATION_BROADCAST_TIERS,
  encodeL1OperationCalldata,
} from '@oxide/oxide-lib/l1_operation_calldata.js';

import { describe, expect, test } from '@jest/globals';
import { type Hex, decodeAbiParameters, parseAbiParameters } from 'viem';

import type { UserRecordArg } from './account_metadata_registry.js';
import {
  type RegistrationIntent,
  type RegistrationProofs,
  decodeRegistrationIntentData,
  decodeRegistrationProofs,
  decodeRegistrationRecord,
  encodeDepositIntentData,
  encodeLegacyRegistrationProofs,
  encodeRegistrationIntentData,
  encodeRegistrationProofs,
  encodeRegistrationRecord,
} from './intent.js';
import { R1_INSTALL_CALL_GAS_BASE, R1_INSTALL_CALL_GAS_PER_WORD, r1InstallCallGas } from './r1_install.js';
import { buildSipaDeployAndSweepOperation } from './sipa_sweep_operation.js';

const [TIER_2K, TIER_4K] = L1_OPERATION_BROADCAST_TIERS;

const RECIPIENT_COMMITMENT = `0x${'ab'.repeat(32)}` as Hex;
const NAME_PORTAL_RECIPIENT = `0x${'ac'.repeat(32)}` as Hex;

const OWNER = '0x1111111111111111111111111111111111111111' as const;
const BENEFICIARY = '0x3333333333333333333333333333333333333333' as const;
const NAME_HASH = `0x${'11'.repeat(32)}` as Hex;
const RECOVERY_COMMITMENT = `0x00${'77'.repeat(31)}` as Hex;
const RECORD: UserRecordArg = {
  l2Address: `0x${'22'.repeat(32)}`,
  rollupVersion: 4n,
  publicKey: { x: 123n, y: 456n },
  resolverOperator: '0x2222222222222222222222222222222222222222',
};

const INTENT: RegistrationIntent = {
  owner: OWNER,
  nameHash: NAME_HASH,
  record: RECORD,
  fee: 1n,
  beneficiary: BENEFICIARY,
  recipientCommitment: RECIPIENT_COMMITMENT,
  namePortalRecipient: NAME_PORTAL_RECIPIENT,
};

const PROOFS: RegistrationProofs = {
  consentSig: `0x${'cd'.repeat(65)}`,
  bootstrap: '0x4444444444444444444444444444444444444444',
  domainAuth: { nonce: 7n, deadline: 111n, signature: `0x${'ef'.repeat(65)}` },
  signedTerms: { fee: 0n, minDeposit: 0n, nonce: 0n, deadline: 0n, signature: '0x' },
  r1Install: {
    qx: `0x${'aa'.repeat(32)}`,
    qy: `0x${'bb'.repeat(32)}`,
    metadata: '0x',
    signature: `0x${'dc'.repeat(65)}`,
  },
};

/** The worst-case registration proofs: the operator signed the terms, so every signature is present. */
const SIGNED_TERMS_PROOFS: RegistrationProofs = {
  ...PROOFS,
  signedTerms: { fee: 1n, minDeposit: 2n, nonce: 3n, deadline: 444n, signature: `0x${'ba'.repeat(65)}` },
};

/** The deploy-and-sweep bundle a broadcaster hands relayers for an undeployed SIPA of `intentData` and `proofs`. */
function sweepBundle(intentData: Hex, proofs: Hex): Buffer {
  const operation = buildSipaDeployAndSweepOperation({
    sipa: OWNER,
    sipaFactory: BENEFICIARY,
    deployArgs: {
      implementation: OWNER,
      intentHash: NAME_HASH,
      recoveryCommitment: RECOVERY_COMMITMENT,
      rollupVersion: 4n,
      resweepable: false,
    },
    sweepArgs: { token: OWNER, relayer: OWNER, intentData, proofs },
    depositSubsidy: BENEFICIARY,
    payoutToken: OWNER,
    condition: L1OperationCondition.immediate(),
  });
  return operation.calldata;
}

describe('intent codec', () => {
  test('deposit intentData is the abi-encoded 32-byte commitment', () => {
    // abi.encode(bytes32) is the word itself, so DepositSIPA's `abi.decode(intentData, (bytes32))` recovers it.
    expect(encodeDepositIntentData(RECIPIENT_COMMITMENT)).toBe(RECIPIENT_COMMITMENT);
  });

  test('registration record round-trips', () => {
    const recordData = encodeRegistrationRecord(OWNER, NAME_HASH, RECORD);
    expect(decodeRegistrationRecord(recordData)).toEqual({ owner: OWNER, nameHash: NAME_HASH, record: RECORD });
  });

  test('registration intent round-trips', () => {
    const intentData = encodeRegistrationIntentData(INTENT);
    expect(decodeRegistrationIntentData(intentData)).toEqual(INTENT);
  });

  // The payment is committed next to the record: the SIPA base pays exactly these values, so a different fee or a
  // different funder is a different SIPA address the payer never funded, and no controller can re-price the one
  // they did.
  test('the fee and the beneficiary change the intent bytes the SIPA address commits to', () => {
    const base = encodeRegistrationIntentData(INTENT);
    expect(encodeRegistrationIntentData({ ...INTENT, fee: 2n })).not.toBe(base);
    const other = '0x4444444444444444444444444444444444444444' as const;
    expect(encodeRegistrationIntentData({ ...INTENT, beneficiary: other })).not.toBe(base);
    expect(decodeRegistrationIntentData(encodeRegistrationIntentData({ ...INTENT, beneficiary: other }))).toEqual({
      ...INTENT,
      beneficiary: other,
    });
  });

  test('registration proofs round-trip', () => {
    const proofs = encodeRegistrationProofs(PROOFS);
    expect(decodeRegistrationProofs(proofs)).toEqual(PROOFS);
  });

  // Registration is the largest intent, and its worst case is operator-signed terms — the terms signature is present
  // only then, and it is what pushes the bundle closest to the cap. The broadcaster's calldata tiers are fixed-size,
  // so a bundle that outgrows the 2k tier rides the 4k one and a bundle that outgrows that the 16 KiB one, which
  // multiplies the broadcaster's proving work. The registration bundle carries the r1 install next to the record and
  // its signatures, which puts it on the 4k tier; a bare deposit keeps the 2k one.
  test('a registration bundle takes the 4k tier and a deposit bundle the 2k tier', () => {
    const registration = sweepBundle(
      encodeRegistrationIntentData(INTENT),
      encodeRegistrationProofs(SIGNED_TERMS_PROOFS),
    );
    expect(encodeL1OperationCalldata(registration).tier).toBe(TIER_4K);
    const deposit = sweepBundle(encodeDepositIntentData(RECIPIENT_COMMITMENT), '0x');
    expect(encodeL1OperationCalldata(deposit).tier).toBe(TIER_2K);
    expect(TIER_4K.fields).toBeGreaterThan(TIER_2K.fields);
  });

  // Pinned so a codec change that inflates the bundle shows up here rather than as a costlier broadcast.
  test('the largest registration bundle measures 2340 bytes, 76 of the 4k tier 133 fields', () => {
    const registration = sweepBundle(
      encodeRegistrationIntentData(INTENT),
      encodeRegistrationProofs(SIGNED_TERMS_PROOFS),
    );
    expect(registration.length).toBe(2340);
    expect(Math.ceil(registration.length / 31)).toBe(76);
    expect(TIER_4K.fields).toBe(133);
  });

  test('the r1 install call gas counts metadata in whole words plus the length word', () => {
    expect(r1InstallCallGas('0x')).toBe(R1_INSTALL_CALL_GAS_BASE);
    expect(r1InstallCallGas(`0x${'00'.repeat(31)}`)).toBe(R1_INSTALL_CALL_GAS_BASE + R1_INSTALL_CALL_GAS_PER_WORD);
    expect(r1InstallCallGas(`0x${'00'.repeat(32)}`)).toBe(R1_INSTALL_CALL_GAS_BASE + 2n * R1_INSTALL_CALL_GAS_PER_WORD);
    expect(r1InstallCallGas(`0x${'00'.repeat(33)}`)).toBe(R1_INSTALL_CALL_GAS_BASE + 3n * R1_INSTALL_CALL_GAS_PER_WORD);
  });
});

test('legacy registration retains its four-field proof encoding', () => {
  const encoded = encodeLegacyRegistrationProofs(PROOFS);
  const decoded = decodeAbiParameters(
    parseAbiParameters(
      'bytes, (uint256 nonce,uint256 deadline,bytes signature), (uint256 fee,uint256 minDeposit,uint256 nonce,uint256 deadline,bytes signature), (bytes32 qx,bytes32 qy,bytes metadata,bytes signature)',
    ),
    encoded,
  );
  expect(decoded).toEqual([PROOFS.consentSig, PROOFS.domainAuth, PROOFS.signedTerms, PROOFS.r1Install]);
  expect(encoded).not.toEqual(encodeRegistrationProofs(PROOFS));
});
