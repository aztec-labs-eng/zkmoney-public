import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import type { PrivateEvent, PrivateEventFilter, Wallet } from '@aztec/aztec.js/wallet';
import { BlockNumber } from '@aztec/foundation/branded-types';
import { type EventMetadataDefinition, EventSelector } from '@aztec/stdlib/abi';
import { randomInTx } from '@aztec/stdlib/tx';

import { describe, expect, it, jest } from '@jest/globals';

import { type SipaEvent, type SipaNotifier, notifySipaRecipient, readSipaEvents } from './sipa_event_calls.js';

type NotifyMethod = SipaNotifier['methods']['notify_sipa_recipient'];

/** The decoded `SIPA` event fields, as the wallet returns them. */
interface SipaEventFields {
  ['shared_secret_salt']: bigint;
  resweepable: boolean;
  ['intent_hash_hi']: bigint;
  ['intent_hash_lo']: bigint;
}

const HI = (1n << 128n) - 2n;
const LO = 0x1234n;
const INTENT_HASH = '0xfffffffffffffffffffffffffffffffe00000000000000000000000000001234';

/** Stands in for the `SIPA` event metadata of the caller's own bindings. */
const SIPA_EVENT: EventMetadataDefinition = {
  eventSelector: EventSelector.fromField(new Fr(7n)),
  abiType: { kind: 'field' },
  fieldNames: ['shared_secret_salt', 'resweepable', 'intent_hash_hi', 'intent_hash_lo'],
};

/** A hand-written OxideToken slice. */
function fakeToken() {
  const notify = jest.fn<NotifyMethod>(() => ({}) as ContractFunctionInteraction);
  const token: SipaNotifier = { methods: { ['notify_sipa_recipient']: notify } };
  return { token, notify };
}

/** A hand-written wallet that returns `events` and records each query. */
function fakeWallet(events: SipaEventFields[]) {
  const queries: { metadata: EventMetadataDefinition; filter: PrivateEventFilter }[] = [];
  const wallet: Pick<Wallet, 'getPrivateEvents'> = {
    getPrivateEvents<T>(metadata: EventMetadataDefinition, filter: PrivateEventFilter) {
      queries.push({ metadata, filter });
      return Promise.resolve(events.map(event => ({ event, metadata: randomInTx() })) as PrivateEvent<T>[]);
    },
  };
  return { wallet, queries };
}

describe('notifySipaRecipient', () => {
  it('splits the intent hash into big-endian 128-bit limbs', () => {
    const { token, notify } = fakeToken();
    const recipient = AztecAddress.fromBigIntUnsafe(5n);
    const event: SipaEvent = { sharedSecretSalt: new Fr(3n), resweepable: true, intentHash: INTENT_HASH };

    notifySipaRecipient(token, recipient, event);

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toEqual([recipient, event.sharedSecretSalt, true, HI, LO]);
  });

  it('gives a zero high limb for a hash below 2^128', () => {
    const { token, notify } = fakeToken();
    const event: SipaEvent = {
      sharedSecretSalt: Fr.ONE,
      resweepable: false,
      intentHash: `0x${'00'.repeat(16)}${'ff'.repeat(16)}`,
    };

    notifySipaRecipient(token, AztecAddress.ZERO, event);

    expect(notify.mock.calls[0].slice(2)).toEqual([false, 0n, (1n << 128n) - 1n]);
  });
});

describe('readSipaEvents', () => {
  it('queries the given event for the recipient on the token, and joins the limbs into a 32-byte hash', async () => {
    const token = AztecAddress.fromBigIntUnsafe(9n);
    const recipient = AztecAddress.fromBigIntUnsafe(5n);
    const { wallet, queries } = fakeWallet([
      { ['shared_secret_salt']: 3n, resweepable: true, ['intent_hash_hi']: HI, ['intent_hash_lo']: LO },
      { ['shared_secret_salt']: 4n, resweepable: false, ['intent_hash_hi']: 0n, ['intent_hash_lo']: 1n },
    ]);

    const events = await readSipaEvents(wallet, SIPA_EVENT, token, recipient, { fromBlock: BlockNumber(3) });

    expect(queries).toHaveLength(1);
    expect(queries[0].metadata).toBe(SIPA_EVENT);
    expect(queries[0].filter).toEqual({ fromBlock: 3, contractAddress: token, scopes: [recipient] });
    expect(events).toEqual([
      { sharedSecretSalt: new Fr(3n), resweepable: true, intentHash: INTENT_HASH },
      { sharedSecretSalt: new Fr(4n), resweepable: false, intentHash: `0x${'00'.repeat(31)}01` },
    ]);
  });

  it('reads back the intent hash that notifySipaRecipient sent', async () => {
    const { token, notify } = fakeToken();
    const sent: SipaEvent = { sharedSecretSalt: new Fr(3n), resweepable: true, intentHash: `0x${'5a'.repeat(32)}` };
    notifySipaRecipient(token, AztecAddress.ZERO, sent);
    const [, salt, resweepable, hi, lo] = notify.mock.calls[0];
    const { wallet } = fakeWallet([
      { ['shared_secret_salt']: salt.toBigInt(), resweepable, ['intent_hash_hi']: hi, ['intent_hash_lo']: lo },
    ]);

    expect(await readSipaEvents(wallet, SIPA_EVENT, AztecAddress.ZERO, AztecAddress.ZERO)).toEqual([sent]);
  });
});
