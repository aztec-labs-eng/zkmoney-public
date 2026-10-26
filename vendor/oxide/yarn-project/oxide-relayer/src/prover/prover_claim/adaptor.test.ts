import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec-labs/foundation/branded-types';
import { Fr } from '@aztec-labs/foundation/curves/bn254';
import { EthAddress } from '@aztec-labs/foundation/eth-address';
import { AztecAddress } from '@aztec-labs/stdlib/aztec-address';
import { TxHash } from '@aztec-labs/stdlib/tx';

import { FrozenEvent } from '@oxide/l1-contracts/oxide_portal.js';
import type { PortalDomain } from '@oxide/oxide-lib/types.js';

import { beforeAll, describe, expect, it, jest } from '@jest/globals';

import { initiationFixture, plainWithdrawalFinalizationData } from '../../l1_operations/initiation_fixture.js';
import { FinalizationRequestSource } from '../finalization_request_source.js';
import { ObservedTx, TxRef } from '../prover_claim_lib/index.js';
import { ProverClaimAdaptor, ProverClaimAdaptorDeps, ProverClaimDiscoveryAdaptor } from './adaptor.js';

// One initiation tx with one broadcast finalization request; each test observes it at a different epoch and checkpoint.
let portalDomain: PortalDomain;
let fixture: Awaited<ReturnType<typeof initiationFixture>>;

beforeAll(async () => {
  portalDomain = {
    l1Portal: EthAddress.random(),
    l2Token: await AztecAddress.random(),
    teeRegistry: EthAddress.random(),
    rollupVersion: 3n,
    l1ChainId: 31337n,
  };
  fixture = await initiationFixture(portalDomain, [plainWithdrawalFinalizationData(EthAddress.random())]);
});

const observedTx = (epoch: number, checkpoint: number): ObservedTx => ({
  epochNumber: EpochNumber(epoch),
  checkpointNumber: CheckpointNumber(checkpoint),
  blockNumber: BlockNumber(10),
  txIndexInBlock: 0,
  txEffect: fixture.effect,
});

const txRef = (epoch: number, checkpoint: number): TxRef => ({
  epochNumber: EpochNumber(epoch),
  checkpointNumber: CheckpointNumber(checkpoint),
  blockNumber: BlockNumber(10),
  txHash: TxHash.random(),
});

const portalBase = () => ({
  address: portalDomain.l1Portal,
  getPortalDomain: () => Promise.resolve(portalDomain),
});

// Frozen at epoch 2, checkpoint 5, with the outbox filled to depth 5 at the freeze.
const frozenPortal = (onFrozen?: (cb: (event: FrozenEvent) => unknown) => void) =>
  ({
    ...portalBase(),
    isFrozen: () => Promise.resolve(true),
    getFreezeCheckpointNumber: () => Promise.resolve(CheckpointNumber(5)),
    getFreezeEpochNumber: () => Promise.resolve(EpochNumber(2)),
    getFreezeCheckpointCount: () => Promise.resolve(5n),
    listenToFrozen: (cb: (event: FrozenEvent) => unknown) => {
      onFrozen?.(cb);
      return () => {};
    },
  }) as any;

const livePortal = () =>
  ({ ...portalBase(), isFrozen: () => Promise.resolve(false), listenToFrozen: () => () => {} }) as any;

const deps = (portal: any): ProverClaimAdaptorDeps => ({
  node: fixture.node as any,
  portal,
  requestSource: requestSourceOf(fixture),
  rollup: {} as any,
  signer: {} as any,
});

const requestSourceOf = (initiation: Awaited<ReturnType<typeof initiationFixture>>) =>
  new FinalizationRequestSource(initiation.node, portalDomain, initiation.broadcaster);

describe('ProverClaimDiscoveryAdaptor freeze gating', () => {
  it('discovers a claim on a live portal', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: livePortal(),
      requestSource: requestSourceOf(fixture),
    });
    expect(await adaptor.buildProverClaims(observedTx(9, 9))).toHaveLength(1);
  });

  it('drops a claim whose initiation lands past the freeze boundary', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: frozenPortal(),
      requestSource: requestSourceOf(fixture),
    });
    // A later epoch, and the freeze epoch beyond the freeze checkpoint, are both cut off.
    expect(await adaptor.buildProverClaims(observedTx(3, 1))).toEqual([]);
    expect(await adaptor.buildProverClaims(observedTx(2, 6))).toEqual([]);
  });

  it('keeps a claim whose initiation is within the freeze boundary', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: frozenPortal(),
      requestSource: requestSourceOf(fixture),
    });
    // Freeze epoch (2), checkpoint at or before the freeze checkpoint (5): still payable, still discovered.
    expect(await adaptor.buildProverClaims(observedTx(2, 5))).toHaveLength(1);
  });

  it('drops a claim once a freeze lands after creation', async () => {
    let onFrozen: ((event: FrozenEvent) => unknown) | undefined;
    const portal = {
      ...portalBase(),
      isFrozen: () => Promise.resolve(false),
      listenToFrozen: (cb: (event: FrozenEvent) => unknown) => {
        onFrozen = cb;
        return () => {};
      },
    } as any;
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal,
      requestSource: requestSourceOf(fixture),
    });
    const tx = observedTx(2, 6);
    expect(await adaptor.buildProverClaims(tx)).toHaveLength(1);

    onFrozen!({
      checkpointNumber: CheckpointNumber(5),
      epochNumber: EpochNumber(2),
      archive: Fr.random(),
      freezeCheckpointCount: 5n,
    });
    expect(await adaptor.buildProverClaims(tx)).toEqual([]);
  });
});

describe('ProverClaimDiscoveryAdaptor request discovery', () => {
  it('reports the content, tip, and message index of each broadcast request', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: livePortal(),
      requestSource: requestSourceOf(fixture),
    });
    const [claim] = await adaptor.buildProverClaims(observedTx(1, 1));
    expect(claim).toMatchObject({ proverTip: 10n, withdrawalIndex: 0, messageIndexInTx: 0 });
  });

  it('finds the withdrawal index of a request and keeps one request per withdrawal', async () => {
    const withdrawals = [
      plainWithdrawalFinalizationData(EthAddress.random()),
      plainWithdrawalFinalizationData(EthAddress.random()),
    ];
    const initiation = await initiationFixture(portalDomain, withdrawals, [withdrawals[1], withdrawals[1]]);
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: livePortal(),
      requestSource: requestSourceOf(initiation),
    });
    const tx = { ...observedTx(1, 1), txEffect: initiation.effect };
    expect(await adaptor.buildProverClaims(tx)).toMatchObject([{ withdrawalIndex: 1, messageIndexInTx: 1 }]);
  });

  it('discovers nothing without a request', async () => {
    const silent = await initiationFixture(portalDomain, [plainWithdrawalFinalizationData(EthAddress.random())], []);
    const adaptor = await ProverClaimDiscoveryAdaptor.create({
      portal: livePortal(),
      requestSource: requestSourceOf(silent),
    });
    const tx = { ...observedTx(1, 1), txEffect: silent.effect };
    expect(await adaptor.buildProverClaims(tx)).toEqual([]);
  });
});

describe('ProverClaimAdaptor freeze gating', () => {
  it('does not cut off any claim while the portal is live', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(livePortal()));
    expect(await adaptor.buildProverClaims(observedTx(9, 9))).toHaveLength(1);
  });

  it('drops a claim whose initiation lands past the freeze boundary', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(frozenPortal()));
    // A later epoch, and the freeze epoch beyond the freeze checkpoint, are both cut off.
    expect(await adaptor.buildProverClaims(observedTx(3, 1))).toEqual([]);
    expect(await adaptor.buildProverClaims(observedTx(2, 6))).toEqual([]);
  });

  it('keeps a claim whose initiation is within the freeze boundary', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(frozenPortal()));
    // Freeze epoch (2), checkpoint at or before the freeze checkpoint (5).
    expect(await adaptor.buildProverClaims(observedTx(2, 5))).toHaveLength(1);
  });

  it('returns an error result for a cut-off claim without fetching its archive', async () => {
    const rollup = { archiveAt: jest.fn() } as any;
    const adaptor = await ProverClaimAdaptor.create({ ...deps(frozenPortal()), rollup });
    // Freeze epoch (2) beyond the freeze checkpoint (5): the claim is excluded before any assembly work.
    const result = await adaptor.buildProverClaimData(txRef(2, 6), 0, 10n, {} as any);
    expect(result.status).toBe('error');
    expect(rollup.archiveAt).not.toHaveBeenCalled();
  });

  it('catches a freeze that lands during startup, between subscribing and the isFrozen read', async () => {
    let onFrozen: ((event: FrozenEvent) => unknown) | undefined;
    const portal = {
      ...portalBase(),
      listenToFrozen: (cb: (event: FrozenEvent) => unknown) => {
        onFrozen = cb;
        return () => {};
      },
      // The Frozen event fires while `isFrozen()` is awaited; the listener attached first must capture it even
      // though this read returns false.
      isFrozen: () => {
        onFrozen!({
          checkpointNumber: CheckpointNumber(5),
          epochNumber: EpochNumber(2),
          archive: Fr.random(),
          freezeCheckpointCount: 5n,
        });
        return Promise.resolve(false);
      },
      getFreezeCheckpointNumber: () => Promise.resolve(CheckpointNumber(5)),
      getFreezeEpochNumber: () => Promise.resolve(EpochNumber(2)),
      getFreezeCheckpointCount: () => Promise.resolve(5n),
    } as any;
    const adaptor = await ProverClaimAdaptor.create(deps(portal));
    expect(await adaptor.buildProverClaims(observedTx(2, 6))).toEqual([]);
  });
});
