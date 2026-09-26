import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { PrivateEventFilter, Wallet } from '@aztec/aztec.js/wallet';

import { OxideTokenContract } from '@oxide/noir-contracts.js/OxideToken';

import { type SipaEvent, type SipaNotifier, readSipaEvents } from './sipa_event_calls.js';

export { notifySipaRecipient, type SipaEvent } from './sipa_event_calls.js';

// Compile-time check: the generated bindings satisfy the structural type of `sipa_event_calls.ts`.
// A contract or codegen change that breaks it fails this build.
type Satisfies<T extends U, U> = T;
type _BindingsSatisfyStructuralTypes = Satisfies<OxideTokenContract, SipaNotifier>;

/** Read SIPA events after contract sync. Register the sender with the wallet before calling this function. */
export async function fetchSipaEvents(
  wallet: Pick<Wallet, 'getPrivateEvents'>,
  token: AztecAddress,
  recipient: AztecAddress,
  filter: Pick<PrivateEventFilter, 'fromBlock' | 'toBlock' | 'txHash'> = {},
): Promise<SipaEvent[]> {
  return await readSipaEvents(wallet, OxideTokenContract.events.SIPA, token, recipient, filter);
}
