import { EthAddress } from '@aztec/aztec.js/addresses';

import { addressKey } from '@oxide/watcher-lib/address-key';
import type { SanctionsList } from '@oxide/watcher-lib/sanctions';

import { type Hex, type Log, toEventSelector } from 'viem';

import type { PendingL1Operation } from '../state/types.js';
import type { PredicateScreener } from './predicate_screener.js';

/** ERC-20 `Transfer` has three topics: the selector and the indexed `from` and `to`. */
const TRANSFER_SELECTOR = toEventSelector('Transfer(address,address,uint256)');

/**
 * The screen an L1 operation passes after it is simulated and before it is submitted. It checks `target`,
 * `payoutToken`, every log emitter, and both parties of each ERC-20 `Transfer` log (the ETH pseudo-token included)
 * against the SDN list first, which is in memory and free, then the Predicate policy where one is configured, one API
 * call per address. A Predicate error propagates; the submitter defers the operation instead of executing it
 * unscreened.
 */
export class L1OperationScreener {
  constructor(
    private readonly sanctionsList: SanctionsList,
    private readonly predicate?: Pick<PredicateScreener, 'isCompliant'>,
  ) {}

  /** Returns sanction addresses or the addresses flagged by Predicate (if predicate is provided). */
  async screen(operation: PendingL1Operation, logs: readonly Log[]): Promise<EthAddress[]> {
    const listed: EthAddress[] = [];
    for (const address of this.#collectScreenedAddresses(operation, logs)) {
      if (this.sanctionsList.isListed(address)) {
        listed.push(address);
      } else if (this.predicate && !(await this.predicate.isCompliant(address))) {
        listed.push(address);
      }
    }
    return listed;
  }

  #collectScreenedAddresses(operation: PendingL1Operation, logs: readonly Log[]): EthAddress[] {
    const seen = new Map<string, EthAddress>();
    const add = (address: EthAddress) => {
      const key = addressKey(address);
      if (!seen.has(key)) {
        seen.set(key, address);
      }
    };
    add(operation.target);
    add(operation.payoutToken);
    for (const log of logs) {
      add(EthAddress.fromString(log.address.toLowerCase()));
      const [selector, from, to, ...rest] = log.topics;
      if (selector !== TRANSFER_SELECTOR || from === undefined || to === undefined || rest.length > 0) {
        continue;
      }
      add(this.#topicToAddress(from));
      add(this.#topicToAddress(to));
    }
    return [...seen.values()];
  }

  /** An indexed `address` topic is the address left-padded to 32 bytes. */
  #topicToAddress(topic: Hex): EthAddress {
    return EthAddress.fromString(`0x${topic.slice(-40).toLowerCase()}`);
  }
}
