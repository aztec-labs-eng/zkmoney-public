/**
 * `collectAccountingEffects` against hand-built offchain effects: which effects it selects from the shared
 * `emit_offchain_effect` channel, and which malformed accounting effects it rejects.
 */
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { OFFCHAIN_MESSAGE_IDENTIFIER, type OffchainEffect, TxHash } from '@aztec/stdlib/tx';

import {
  ACCOUNTING_EFFECT_IDENTIFIER,
  DEPOSIT_EFFECT_TYPE,
  INSERTION_EFFECT_TYPE,
  NULLIFICATION_EFFECT_TYPE,
  WITHDRAWAL_EFFECT_TYPE,
} from '@oxide/oxide-lib/oxide_constants.gen.js';

import { beforeAll, describe, expect, it } from '@jest/globals';

import { PermanentError } from './errors.js';
import { NoteStage, collectAccountingEffects } from './token_operations_collector.js';

let token: AztecAddress;
let owner: AztecAddress;

beforeAll(async () => {
  token = await AztecAddress.random();
  owner = await AztecAddress.random();
});

function effect(contractAddress: AztecAddress, data: Fr[]): OffchainEffect {
  return { contractAddress, data };
}

function accounting(typ: number, payload: Fr[]): Fr[] {
  return [new Fr(ACCOUNTING_EFFECT_IDENTIFIER), new Fr(typ), ...payload];
}

// A settled-note nullification (non-zero creation tx hash), so squashing leaves it alone.
function nullificationData(): Fr[] {
  return accounting(NULLIFICATION_EFFECT_TYPE, [
    new Fr(100n),
    owner.toField(),
    Fr.random(),
    Fr.random(),
    Fr.random(),
    new Fr(NoteStage.SETTLED),
    Fr.ZERO,
    Fr.random(),
    Fr.random(),
    Fr.random(),
    Fr.random(),
    new Fr(42n),
  ]);
}

function insertionData(): Fr[] {
  return accounting(INSERTION_EFFECT_TYPE, [new Fr(200n), owner.toField(), Fr.random(), Fr.random()]);
}

function withdrawalData(): Fr[] {
  // WithdrawalEffect payload: executor, user_payload_hash, amount, prover_tip, randomness.
  return accounting(WITHDRAWAL_EFFECT_TYPE, [
    EthAddress.random().toField(),
    Fr.random(),
    new Fr(300n),
    new Fr(2n),
    Fr.random(),
  ]);
}

function depositData(): Fr[] {
  return accounting(DEPOSIT_EFFECT_TYPE, [owner.toField(), new Fr(400n), Fr.random(), new Fr(7n), Fr.random()]);
}

describe('collectAccountingEffects', () => {
  it('collects all four accounting effect shapes', () => {
    const collected = collectAccountingEffects(token, [
      effect(token, nullificationData()),
      effect(token, insertionData()),
      effect(token, withdrawalData()),
      effect(token, depositData()),
    ]);

    expect(collected.nullifiedNotes).toHaveLength(1);
    expect(collected.nullifiedNotes[0].owner.equals(owner)).toBe(true);
    expect(collected.nullifiedNotes[0].creationTxHash.equals(TxHash.fromField(new Fr(42n)))).toBe(true);
    expect(collected.createdNotes).toHaveLength(1);
    expect(collected.createdNotes[0].amount).toBe(200n);
    expect(collected.withdrawals).toHaveLength(1);
    expect(collected.withdrawals[0].amount).toBe(300n);
    expect(collected.deposits).toHaveLength(1);
    expect(collected.deposits[0].amount).toBe(400n);
    expect(collected.squashedTransientNotes).toHaveLength(0);
  });

  it('skips every effect that does not carry the accounting identifier', async () => {
    const other = await AztecAddress.random();
    const collected = collectAccountingEffects(token, [
      // An aztec-nr offchain message.
      effect(token, [OFFCHAIN_MESSAGE_IDENTIFIER, owner.toField(), Fr.random()]),
      // A private event the token delivered offchain: arbitrary leading field, arbitrary length.
      effect(token, [Fr.random(), Fr.random(), Fr.random()]),
      // A payload whose leading field happens to equal an accounting `typ`.
      effect(token, [new Fr(INSERTION_EFFECT_TYPE), Fr.random()]),
      effect(token, []),
      // An accounting effect from another contract.
      effect(other, insertionData()),
      effect(token, insertionData()),
    ]);

    expect(collected.createdNotes).toHaveLength(1);
    expect(collected.createdNotes[0].amount).toBe(200n);
    expect(collected.nullifiedNotes).toHaveLength(0);
    expect(collected.withdrawals).toHaveLength(0);
    expect(collected.deposits).toHaveLength(0);
  });

  it('throws when no accounting effects remain', () => {
    expect(() => collectAccountingEffects(token, [effect(token, [Fr.random(), Fr.random()])])).toThrow(PermanentError);
  });

  it('rejects malformed accounting effects instead of skipping them', () => {
    const unknownTyp = accounting(0xff, [Fr.random()]);
    expect(() => collectAccountingEffects(token, [effect(token, unknownTyp)])).toThrow(/Unknown effect type/);

    const truncatedNullification = nullificationData().slice(0, 7);
    expect(() => collectAccountingEffects(token, [effect(token, truncatedNullification)])).toThrow(
      /Expected 14 fields for NullificationEffect/,
    );

    const identifierOnly = [new Fr(ACCOUNTING_EFFECT_IDENTIFIER)];
    expect(() => collectAccountingEffects(token, [effect(token, identifierOnly)])).toThrow(PermanentError);
  });
});
