import { EthAddress } from '@aztec-labs/foundation/eth-address';
import type { Logger } from '@aztec-labs/foundation/log';

import { MAINNET_DAI } from '@oxide/l1-contracts';
import { addressKey } from '@oxide/watcher-lib/address-key';

import { describe, expect, it } from '@jest/globals';

import { PayoutTokenRegistry } from './payout_token_registry.js';

const TESTNET = 11155111n;

/** Records each token that it is asked to add, and refuses each token in `refused`. */
function fakePricer(added: EthAddress[] = [], refused: EthAddress[] = []) {
  return {
    addToken: (token: EthAddress) => {
      added.push(token);
      return refused.some(other => other.equals(token))
        ? Promise.reject(new Error(`cannot price token ${token.toString()}`))
        : Promise.resolve();
    },
  };
}

/** A logger that records the info and warn messages. */
function recordingLog() {
  const info: string[] = [];
  const warn: string[] = [];
  const log = { info: (m: string) => info.push(m), warn: (m: string) => warn.push(m) } as unknown as Logger;
  return { info, warn, log };
}

/** A logger whose messages no test reads. */
const quiet = recordingLog().log;

/** The accepted tokens as `list()` reports them. */
const keys = (...tokens: EthAddress[]) => tokens.map(token => addressKey(token));

describe('PayoutTokenRegistry', () => {
  const dai = EthAddress.random();
  const sUsds = EthAddress.random();

  /** A default registry with each of `tokens` registered as a deployment, as `runRelayer` does at startup. */
  async function registered(chainId: bigint, tokens: EthAddress[], pricer = fakePricer(), log = quiet) {
    const registry = await PayoutTokenRegistry.create(pricer, undefined, { chainId, log });
    for (const [index, token] of tokens.entries()) {
      await registry.addDeployment({ label: `v${index + 1}`, token });
    }
    return registry;
  }

  it('starts empty and accepts the token of every registered deployment, so the sUSDS worker accepts DAI', async () => {
    const empty = await PayoutTokenRegistry.create(fakePricer(), undefined, { chainId: TESTNET, log: quiet });
    expect(empty.list()).toEqual([]);
    const registry = await registered(TESTNET, [sUsds, dai]);
    expect(registry.list()).toEqual(keys(sUsds, dai));
    expect(registry.accepts(dai)).toBe(true);
    expect(registry.accepts(EthAddress.random())).toBe(false);
  });

  it('accepts DAI on mainnet, where deposit sweeps pay out in DAI', async () => {
    const registry = await registered(1n, [sUsds]);
    expect(registry.list()).toEqual(keys(sUsds, MAINNET_DAI));
  });

  it('widens the tokens for a worker that already holds the registry, and logs the change', async () => {
    const { info, log } = recordingLog();
    const registry = await registered(TESTNET, [dai], fakePricer(), log);
    // A worker started before the addition holds the same registry as its filter.
    const filter = registry;
    expect(filter.accepts(sUsds)).toBe(false);

    await registry.addDeployment({ label: 'v2', token: sUsds });
    expect(filter.accepts(sUsds)).toBe(true);
    expect(info).toEqual([
      `accepting ${dai.toString()} as a payout token for every worker, from deployment v1`,
      `accepting ${sUsds.toString()} as a payout token for every worker, from deployment v2`,
    ]);
  });

  it('adds a token to the pricer only when it is new', async () => {
    const added: EthAddress[] = [];
    const registry = await registered(TESTNET, [dai, sUsds], fakePricer(added));
    expect(added).toEqual([dai, sUsds]);
    added.length = 0;
    await registry.addDeployment({ label: 'v3', token: dai });
    expect(added).toEqual([]);
  });

  it('fails a deployment with a token that the pricer refuses and adds nothing', async () => {
    const odd = EthAddress.random();
    const registry = await registered(TESTNET, [dai], fakePricer([], [odd]));
    await expect(registry.addDeployment({ label: 'v3', token: odd })).rejects.toThrow(
      `deployment v3: cannot price token ${odd.toString()}`,
    );
    expect(registry.list()).toEqual(keys(dai));
  });

  it('keeps a configured list fixed, after it adds each token to the pricer', async () => {
    const added: EthAddress[] = [];
    const registry = await PayoutTokenRegistry.create(fakePricer(added), [dai, sUsds], { chainId: 1n, log: quiet });
    expect(added).toEqual([dai, sUsds]);
    await registry.addDeployment({ label: 'v4', token: EthAddress.random() });
    expect(registry.list()).toEqual(keys(dai, sUsds));
  });

  it('fails startup when the configured list is empty', async () => {
    await expect(PayoutTokenRegistry.create(fakePricer(), [], { chainId: TESTNET, log: quiet })).rejects.toThrow(
      'the configured payout tokens must contain at least one token',
    );
  });

  it('fails startup when the pricer refuses one configured token', async () => {
    await expect(
      PayoutTokenRegistry.create(fakePricer([], [sUsds]), [dai, sUsds], { chainId: TESTNET, log: quiet }),
    ).rejects.toThrow(`cannot price token ${sUsds.toString()}`);
  });
});
