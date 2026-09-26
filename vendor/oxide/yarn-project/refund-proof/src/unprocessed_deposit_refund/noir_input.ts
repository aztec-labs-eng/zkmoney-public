// Translates the TS-side `UnprocessedDepositRefundProofInput` into the structured `InputMap`
// shape that `@aztec/noir-noir_js`'s `Noir.execute` expects for the unprocessed_deposit_refund
// circuit. Field names (snake_case) and nesting must match the noir struct layout in
// `noir-projects/unprocessed_deposit_refund/src/main.nr`.
import { Fr } from '@aztec/aztec.js/fields';

import {
  fieldStr,
  mapAccountInstancePreimage,
  mapBlockHeader,
  mapGrumpkinScalar,
  mapPublicKeys,
  mapRefundAuthorization,
} from '../noir_input_mappers.js';
import type { UnprocessedDepositRefundProofInput } from './types.js';

/* eslint-disable camelcase */

export function buildUnprocessedDepositRefundNoirInput(
  input: UnprocessedDepositRefundProofInput,
): Record<string, unknown> {
  return {
    chain_id: fieldStr(new Fr(input.chainId)),
    rollup_version: fieldStr(new Fr(input.rollupVersion)),
    l2_token: { inner: fieldStr(input.l2Token.toField()) },
    frozen_archive_root: fieldStr(input.frozenArchiveRoot),
    amount: input.amount.toString(),
    executor: { inner: fieldStr(input.executor.toField()) },
    user_payload_hash: fieldStr(input.userPayloadHash),
    message_hash: fieldStr(input.messageHash),
    message_leaf_index: fieldStr(input.messageLeafIndex),
    frozen_tip: mapBlockHeader(input.frozenTip),
    frozen_tip_sibling_path: input.frozenTipSiblingPath.map(fieldStr),
    l1_portal: { inner: fieldStr(input.l1Portal.toField()) },
    shared_secret_salt: fieldStr(input.sharedSecretSalt),
    l2_recipient: { inner: fieldStr(input.l2Recipient.toField()) },
    l2_recipient_public_keys: mapPublicKeys(input.l2RecipientPublicKeys),
    l2_recipient_instance: mapAccountInstancePreimage(input.l2RecipientInstance),
    l2_recipient_nhk_m: mapGrumpkinScalar(input.l2RecipientNhkM),
    auth: mapRefundAuthorization(input.auth),
  };
}
