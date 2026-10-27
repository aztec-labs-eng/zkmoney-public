// Translates the TS-side `FrozenDepositsRefundProofInput` into the structured `InputMap` shape that
// `@aztec-foundation/noir-noir_js`'s `Noir.execute` expects for the frozen_deposits_refund circuit.
// Field names (snake_case) and nesting must match the noir struct layout in
// `noir-projects/frozen_deposits_refund/src/main.nr`.
import { Fr } from '@aztec-labs/aztec.js/fields';

import {
  fieldStr,
  mapAccountInstancePreimage,
  mapBlockHeader,
  mapGrumpkinScalar,
  mapMembershipWitness,
  mapMigrationSignature,
  mapPublicKeys,
} from '../noir_input_mappers.js';
import type { FrozenDepositsRefundProofInput, RefundInputDeposit } from './types.js';

/* eslint-disable camelcase */

export function buildFrozenDepositsRefundNoirInput(input: FrozenDepositsRefundProofInput): Record<string, unknown> {
  return {
    chain_id: fieldStr(new Fr(input.chainId)),
    rollup_version: fieldStr(new Fr(input.rollupVersion)),
    l2_token: { inner: fieldStr(input.l2Token.toField()) },
    frozen_archive_root: fieldStr(input.archiveRoot),
    amount: input.amount.toString(),
    executor: { inner: fieldStr(input.executor.toField()) },
    user_payload_hash: fieldStr(input.userPayloadHash),
    frozen_tip: mapBlockHeader(input.frozenTip),
    frozen_tip_sibling_path: input.frozenTipSiblingPath.map(fieldStr),
    l1_portal: { inner: fieldStr(input.l1Portal.toField()) },
    l2_recipient: { inner: fieldStr(input.l2Recipient.toField()) },
    l2_recipient_public_keys: mapPublicKeys(input.l2RecipientPublicKeys),
    l2_recipient_instance: mapAccountInstancePreimage(input.l2RecipientInstance),
    l2_recipient_nhk_m: mapGrumpkinScalar(input.l2RecipientNhkM),
    deposits: input.deposits.map(mapInputDeposit),
    migration_signature: mapMigrationSignature(input.migrationSignature),
  };
}

function mapInputDeposit(deposit: RefundInputDeposit): Record<string, unknown> {
  return {
    amount: deposit.amount.toString(),
    shared_secret_salt: fieldStr(deposit.sharedSecretSalt),
    message_leaf_index: fieldStr(deposit.messageLeafIndex),
    message_membership_sibling_path: deposit.messageMembershipSiblingPath.map(fieldStr),
    low_nullifier_preimage: {
      nullifier: fieldStr(deposit.lowNullifierPreimage.leaf.nullifier),
      next_nullifier: fieldStr(deposit.lowNullifierPreimage.nextKey),
      next_index: Number(deposit.lowNullifierPreimage.nextIndex).toString(),
    },
    low_nullifier_membership_witness: mapMembershipWitness(deposit.lowNullifierMembershipWitness),
  };
}
