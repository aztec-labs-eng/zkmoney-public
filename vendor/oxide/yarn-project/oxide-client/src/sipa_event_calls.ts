// The SIPA event calls that need no generated bindings. The token handle is a structural slice of the contract
// interface and the caller supplies the event metadata, so clients that do not build `@oxide/noir-contracts.js` can
// call them with their own bindings.
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import { Fr } from '@aztec/aztec.js/fields';
import type { PrivateEventFilter, Wallet } from '@aztec/aztec.js/wallet';
import type { EventMetadataDefinition } from '@aztec/stdlib/abi';

import { type Hex, toHex } from 'viem';

/** Minimum amount of info the recipient needs to find a SIPA and the corresponding deposit. */
export interface SipaEvent {
  sharedSecretSalt: Fr;
  resweepable: boolean;
  intentHash: Hex;
}

/** The slice of the OxideToken bindings that {@link notifySipaRecipient} uses. */
export interface SipaNotifier {
  methods: {
    ['notify_sipa_recipient']: (
      recipient: AztecAddress,
      sharedSecretSalt: Fr,
      resweepable: boolean,
      intentHashHi: bigint,
      intentHashLo: bigint,
    ) => ContractFunctionInteraction;
  };
}

/**
 * Notify the recipient of a SIPA. Batch the sweep broadcast into the same L2 transaction.
 * TODO(benesjan): Fit intentHash into one field and drop this helper and the event above.
 */
export function notifySipaRecipient(
  token: SipaNotifier,
  recipient: AztecAddress,
  event: SipaEvent,
): ContractFunctionInteraction {
  const intentHash = BigInt(event.intentHash);
  return token.methods.notify_sipa_recipient(
    recipient,
    event.sharedSecretSalt,
    event.resweepable,
    intentHash >> 128n,
    intentHash & ((1n << 128n) - 1n),
  );
}

/**
 * Read SIPA events after contract sync. Register the sender with the wallet before calling this function.
 * `sipaEvent` is the `SIPA` event metadata of the caller's OxideToken bindings.
 */
export async function readSipaEvents(
  wallet: Pick<Wallet, 'getPrivateEvents'>,
  sipaEvent: EventMetadataDefinition,
  token: AztecAddress,
  recipient: AztecAddress,
  filter: Pick<PrivateEventFilter, 'fromBlock' | 'toBlock' | 'txHash'> = {},
): Promise<SipaEvent[]> {
  const events = await wallet.getPrivateEvents<{
    shared_secret_salt: bigint;
    resweepable: boolean;
    intent_hash_hi: bigint;
    intent_hash_lo: bigint;
  }>(sipaEvent, { ...filter, contractAddress: token, scopes: [recipient] });
  return events.map(({ event }) => ({
    sharedSecretSalt: new Fr(event.shared_secret_salt),
    resweepable: event.resweepable,
    intentHash: toHex((event.intent_hash_hi << 128n) | event.intent_hash_lo, { size: 32 }),
  }));
}
