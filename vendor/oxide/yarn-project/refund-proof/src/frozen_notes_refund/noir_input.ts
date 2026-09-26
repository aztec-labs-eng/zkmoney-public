// Translates the TS-side `FrozenNotesRefundProofInput` into the structured `InputMap` shape that
// `@aztec/noir-noir_js`'s `Noir.execute` expects for the frozen_notes_refund circuit. Field
// names (snake_case) and nesting must match the noir struct layout in
// `noir-projects/frozen_notes_refund/src/main.nr`.
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
import type { FrozenNotesRefundProofInput, RefundInputNote } from './types.js';

/* eslint-disable camelcase */

export function buildNoirInput(input: FrozenNotesRefundProofInput): Record<string, unknown> {
  return {
    _chain_id: fieldStr(new Fr(input.chainId)),
    _rollup_version: fieldStr(new Fr(input.rollupVersion)),
    _l1_portal: { inner: fieldStr(input.l1Portal.toField()) },
    l2_token: { inner: fieldStr(input.l2Token.toField()) },
    frozen_archive_root: fieldStr(input.frozenArchiveRoot),
    amount: input.amount.toString(),
    executor: { inner: fieldStr(input.executor.toField()) },
    user_payload_hash: fieldStr(input.userPayloadHash),
    frozen_tip: mapBlockHeader(input.frozenTip),
    frozen_tip_sibling_path: input.frozenTipSiblingPath.map(fieldStr),
    notes: input.notes.map(mapInputNote),
    owner: { inner: fieldStr(input.owner.toField()) },
    owner_public_keys: mapPublicKeys(input.ownerPublicKeys),
    owner_instance: mapAccountInstancePreimage(input.ownerInstance),
    owner_nhk_m: mapGrumpkinScalar(input.ownerNhkM),
    auth: mapRefundAuthorization(input.auth),
  };
}

function mapInputNote(note: RefundInputNote): Record<string, unknown> {
  return {
    amount: note.amount.toString(),
    randomness: fieldStr(note.randomness),
    note_nonce: fieldStr(note.noteNonce),
    note_membership_witness: mapMembershipWitness(note.noteMembershipWitness),
    low_nullifier_preimage: {
      nullifier: fieldStr(note.lowNullifierPreimage.leaf.nullifier),
      next_nullifier: fieldStr(note.lowNullifierPreimage.nextKey),
      next_index: Number(note.lowNullifierPreimage.nextIndex).toString(),
    },
    low_nullifier_membership_witness: mapMembershipWitness(note.lowNullifierMembershipWitness),
  };
}
