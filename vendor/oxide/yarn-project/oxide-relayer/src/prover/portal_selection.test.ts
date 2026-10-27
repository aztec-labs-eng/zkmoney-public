import { EthAddress } from '@aztec-labs/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import type { ResolvedManifestDeployment } from '../config/deployment_env_manifest.js';
import { selectProverPortals } from './portal_selection.js';

const USDS = EthAddress.random();
const SUSDS = EthAddress.random();
const DAI = EthAddress.random();
const ROLLUP_VERSION = 7n;

interface Entry {
  underlying: EthAddress;
  deployment: ResolvedManifestDeployment;
}

/** A manifest entry whose portal pays in `underlying`. */
const entry = (
  label: string,
  underlying: EthAddress,
  { proverSubsidy = EthAddress.random(), rollupVersion = ROLLUP_VERSION } = {},
): Entry => ({
  underlying,
  deployment: {
    label,
    publicConfig: { portal: EthAddress.random(), proverSubsidy, rollupVersion },
  } as unknown as ResolvedManifestDeployment,
});

/** Select from `entries`, the first one pinned, for a prover that proves `ROLLUP_VERSION`. */
const labels = async (payoutTokens: EthAddress[] | undefined, entries: Entry[]) => {
  const [current, ...historical] = entries;
  const manifest = { current: current.deployment, historical: historical.map(e => e.deployment) };
  const readUnderlying = (portal: EthAddress) =>
    Promise.resolve(entries.find(e => e.deployment.publicConfig.portal.equals(portal))!.underlying);
  const selected = await selectProverPortals(manifest, payoutTokens, ROLLUP_VERSION, readUnderlying);
  return selected.map(p => `${p.deployment.label}:${p.underlying}`);
};

describe('selectProverPortals', () => {
  const pinned = entry('pinned', USDS);
  const vault = entry('vault', SUSDS);
  const dai = entry('dai', DAI);
  const entries = [pinned, vault, dai];

  it('selects the pinned entry only when no payout tokens are set', async () => {
    await expect(labels(undefined, entries)).resolves.toEqual([`pinned:${USDS}`]);
  });

  it('selects each entry whose portal pays in a payout token, the pinned entry first', async () => {
    await expect(labels([SUSDS, USDS], entries)).resolves.toEqual([`pinned:${USDS}`, `vault:${SUSDS}`]);
  });

  it('leaves out the pinned entry when its portal pays in no payout token', async () => {
    await expect(labels([SUSDS], entries)).resolves.toEqual([`vault:${SUSDS}`]);
  });

  it('refuses to start when the pinned entry is not on the rollup version that the prover proves', async () => {
    const stale = entry('stale', USDS, { rollupVersion: ROLLUP_VERSION - 1n });

    await expect(labels(undefined, [stale, vault])).rejects.toThrow(/not on rollup version 7/);
  });

  it('refuses to start when no entry pays in a payout token', async () => {
    await expect(labels([EthAddress.random()], entries)).rejects.toThrow(/no deployment of rollup version 7/);
  });

  it('refuses a selected entry that publishes the zero address for proverSubsidy', async () => {
    const broken = entry('broken', SUSDS, { proverSubsidy: EthAddress.ZERO });

    await expect(labels([USDS, SUSDS], [pinned, broken])).rejects.toThrow(/zero address for proverSubsidy/);
    // An entry that is not selected is not checked.
    await expect(labels([USDS], [pinned, broken])).resolves.toEqual([`pinned:${USDS}`]);
  });
});
