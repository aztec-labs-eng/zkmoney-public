// Translates the TS-side `FrozenDepositRefundProofInput` into the structured `InputMap` shape that
// `@aztec/noir-noir_js`'s `Noir.execute` expects for the frozen_deposit_refund circuit.
// Field names (snake_case) and nesting must match the noir struct layout in
// `noir-projects/frozen_deposit_refund/src/main.nr`.
import { Fr } from '@aztec/aztec.js/fields';

import {
  fieldStr,
  mapAccountInstancePreimage,
  mapBlockHeader,
  mapGrumpkinScalar,
  mapMembershipWitness,
  mapPublicKeys,
  mapRefundAuthorization,
} from '../noir_input_mappers.js';
import type { FrozenDepositRefundProofInput } from './types.js';

/* eslint-disable camelcase */

export function buildFrozenDepositRefundNoirInput(input: FrozenDepositRefundProofInput): Record<string, unknown> {
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
    shared_secret_salt: fieldStr(input.sharedSecretSalt),
    l2_recipient: { inner: fieldStr(input.l2Recipient.toField()) },
    l2_recipient_public_keys: mapPublicKeys(input.l2RecipientPublicKeys),
    l2_recipient_instance: mapAccountInstancePreimage(input.l2RecipientInstance),
    l2_recipient_nhk_m: mapGrumpkinScalar(input.l2RecipientNhkM),
    message_leaf_index: fieldStr(input.messageLeafIndex),
    message_membership_sibling_path: input.messageMembershipSiblingPath.map(fieldStr),
    low_nullifier_preimage: {
      nullifier: fieldStr(input.lowNullifierPreimage.leaf.nullifier),
      next_nullifier: fieldStr(input.lowNullifierPreimage.nextKey),
      next_index: Number(input.lowNullifierPreimage.nextIndex).toString(),
    },
    low_nullifier_membership_witness: mapMembershipWitness(input.lowNullifierMembershipWitness),
    auth: mapRefundAuthorization(input.auth),
  };
}
