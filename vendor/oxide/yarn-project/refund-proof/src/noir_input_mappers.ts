// Translates the TS vocabulary of `@oxide/oxide-lib` and `@aztec/stdlib` into the structured `InputMap` shape that
// `@aztec/noir-noir_js`'s `Noir.execute` expects. Field names (snake_case) and nesting must match the Noir structs in
// `noir-projects`. Bytes are decimal strings, like every other `u8`. The three refund circuits share these mappers;
// each circuit keeps its own top-level builder in `<circuit>/noir_input.ts`.
import { Fr } from '@aztec/aztec.js/fields';
import type { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import type { MembershipWitness } from '@aztec/foundation/trees';
import type { PublicKeys } from '@aztec/stdlib/keys';
import type { BlockHeader } from '@aztec/stdlib/tx';

import {
  type AccountInstancePreimage,
  type PasskeyPublicKey,
  WEBAUTHN_AUTHENTICATOR_DATA_LEN,
  WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN,
  type WebAuthnAuth,
} from '@oxide/oxide-lib/account_address.js';
import type { RefundAuthorization } from '@oxide/oxide-lib/refund_authorization.js';
import type { GrumpkinPoseidonSignature } from '@oxide/oxide-lib/types.js';

/* eslint-disable camelcase */

// ---------------------------------------------------------------------------
// Primitives.
// ---------------------------------------------------------------------------

export function fieldStr(field: Fr): string {
  return field.toString();
}

export function mapBytes(bytes: Buffer, expectedLength: number, name: string): string[] {
  if (bytes.length !== expectedLength) {
    throw new Error(`${name} is ${bytes.length} bytes, expected ${expectedLength}`);
  }
  return Array.from(bytes, byte => byte.toString());
}

export function mapPoint(point: { x: Fr; y: Fr; isInfinite: boolean }): Record<string, unknown> {
  return {
    x: fieldStr(point.x),
    y: fieldStr(point.y),
    is_infinite: point.isInfinite,
  };
}

export function mapGrumpkinScalar(scalar: GrumpkinScalar): Record<string, unknown> {
  return {
    hi: fieldStr(scalar.hi),
    lo: fieldStr(scalar.lo),
  };
}

export function mapPublicKeys(publicKeys: PublicKeys): Record<string, unknown> {
  return {
    npk_m_hash: fieldStr(publicKeys.npkMHash),
    ivpk_m: { inner: mapPoint(publicKeys.ivpkM) },
    ovpk_m_hash: fieldStr(publicKeys.ovpkMHash),
    tpk_m_hash: fieldStr(publicKeys.tpkMHash),
    mspk_m_hash: fieldStr(publicKeys.mspkMHash),
    fbpk_m_hash: fieldStr(publicKeys.fbpkMHash),
  };
}

export function mapMembershipWitness<N extends number>(witness: MembershipWitness<N>): Record<string, unknown> {
  return {
    leaf_index: witness.leafIndex.toString(),
    sibling_path: witness.siblingPath.map(fieldStr),
  };
}

export function mapTreeSnapshot(snapshot: { root: Fr; nextAvailableLeafIndex: number }): Record<string, unknown> {
  return {
    root: fieldStr(snapshot.root),
    next_available_leaf_index: fieldStr(new Fr(snapshot.nextAvailableLeafIndex)),
  };
}

export function mapBlockHeader(header: BlockHeader): Record<string, unknown> {
  return {
    last_archive: mapTreeSnapshot(header.lastArchive),
    state: {
      l1_to_l2_message_tree: mapTreeSnapshot(header.state.l1ToL2MessageTree),
      partial: {
        note_hash_tree: mapTreeSnapshot(header.state.partial.noteHashTree),
        nullifier_tree: mapTreeSnapshot(header.state.partial.nullifierTree),
        public_data_tree: mapTreeSnapshot(header.state.partial.publicDataTree),
      },
    },
    sponge_blob_hash: fieldStr(header.spongeBlobHash),
    global_variables: {
      chain_id: fieldStr(header.globalVariables.chainId),
      version: fieldStr(header.globalVariables.version),
      block_number: header.globalVariables.blockNumber.toString(),
      slot_number: fieldStr(new Fr(header.globalVariables.slotNumber)),
      timestamp: header.globalVariables.timestamp.toString(),
      coinbase: { inner: fieldStr(header.globalVariables.coinbase.toField()) },
      fee_recipient: { inner: fieldStr(header.globalVariables.feeRecipient.toField()) },
      gas_fees: {
        fee_per_da_gas: fieldStr(new Fr(header.globalVariables.gasFees.feePerDaGas)),
        fee_per_l2_gas: fieldStr(new Fr(header.globalVariables.gasFees.feePerL2Gas)),
      },
    },
    total_fees: fieldStr(header.totalFees),
    total_mana_used: fieldStr(header.totalManaUsed),
  };
}

// ---------------------------------------------------------------------------
// Account address preimage and WebAuthn.
// ---------------------------------------------------------------------------

export function mapPasskeyPublicKey(passkey: PasskeyPublicKey): Record<string, unknown> {
  return {
    x: mapBytes(passkey.x, 32, 'passkey.x'),
    y: mapBytes(passkey.y, 32, 'passkey.y'),
  };
}

export function mapAccountInstancePreimage(instance: AccountInstancePreimage): Record<string, unknown> {
  return {
    contract_class_id: { inner: instance.contractClassId.toString() },
    salt: instance.salt.toString(),
    initialization_hash: instance.initializationHash.toString(),
    deployer: { inner: instance.deployer.toField().toString() },
  };
}

export function mapWebAuthnAuth(auth: WebAuthnAuth): Record<string, unknown> {
  if (auth.clientDataJSON.length > WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN) {
    throw new Error(`clientDataJSON is ${auth.clientDataJSON.length} bytes, max ${WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN}`);
  }
  // The circuit hashes only the first `client_data_json_len` bytes; the rest is zero padding.
  const paddedClientDataJSON = Buffer.concat([
    auth.clientDataJSON,
    Buffer.alloc(WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN - auth.clientDataJSON.length),
  ]);
  return {
    authenticator_data: mapBytes(auth.authenticatorData, WEBAUTHN_AUTHENTICATOR_DATA_LEN, 'authenticatorData'),
    client_data_json: mapBytes(paddedClientDataJSON, WEBAUTHN_MAX_CLIENT_DATA_JSON_LEN, 'clientDataJSON'),
    client_data_json_len: auth.clientDataJSON.length.toString(),
    signature: mapBytes(auth.signature, 64, 'signature'),
  };
}

// ---------------------------------------------------------------------------
// Refund authorization.
// ---------------------------------------------------------------------------

/** The circuit constrains both modes, so the fields of the mode that is not in use are zeroed. */
const ZERO_PASSKEY: PasskeyPublicKey = { x: Buffer.alloc(32), y: Buffer.alloc(32) };

const ZERO_WEBAUTHN: WebAuthnAuth = {
  authenticatorData: Buffer.alloc(WEBAUTHN_AUTHENTICATOR_DATA_LEN),
  clientDataJSON: Buffer.alloc(0),
  signature: Buffer.alloc(64),
};

const ZERO_SIGNATURE: GrumpkinPoseidonSignature = { sLo: Fr.ZERO, sHi: Fr.ZERO, eLo: Fr.ZERO, eHi: Fr.ZERO };

export function mapRefundAuthorization(auth: RefundAuthorization): Record<string, unknown> {
  const usePasskey = auth.kind === 'passkey';
  const fbpkM = auth.kind === 'fallbackKey' ? auth.fbpkM : { x: Fr.ZERO, y: Fr.ZERO, isInfinite: false };
  const signature = auth.kind === 'fallbackKey' ? auth.signature : ZERO_SIGNATURE;
  return {
    use_passkey: usePasskey,
    passkey: mapPasskeyPublicKey(auth.kind === 'passkey' ? auth.passkey : ZERO_PASSKEY),
    webauthn: mapWebAuthnAuth(auth.kind === 'passkey' ? auth.webauthn : ZERO_WEBAUTHN),
    fbpk_m: mapPoint(fbpkM),
    // Noir `(EmbeddedCurveScalar, EmbeddedCurveScalar)` deserializes from a 2-element array of `{ lo, hi }` objects.
    fallback_signature: [
      { lo: signature.sLo.toString(), hi: signature.sHi.toString() },
      { lo: signature.eLo.toString(), hi: signature.eHi.toString() },
    ],
  };
}
