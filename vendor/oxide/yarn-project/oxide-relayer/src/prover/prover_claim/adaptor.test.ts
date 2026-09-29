import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Fr } from '@aztec/foundation/curves/bn254';
import { EthAddress } from '@aztec/foundation/eth-address';
import { AztecAddress } from '@aztec/stdlib/aztec-address';
import { TxHash } from '@aztec/stdlib/tx';

import { FrozenEvent } from '@oxide/l1-contracts/oxide_portal.js';
import { computeSiloedWithdrawalTag } from '@oxide/oxide-client/published_withdrawal.js';

import { beforeAll, describe, expect, it, jest } from '@jest/globals';

import { ObservedTx, PortalContext, TxRef } from '../prover_claim_lib/index.js';
import { ProverClaimAdaptor, ProverClaimAdaptorDeps, ProverClaimDiscoveryAdaptor } from './adaptor.js';

// Discovery derives its siloed tag from the context's `l2Portal`, so withdrawal logs carry the matching
// siloed tag as their first field.
let l2Portal: AztecAddress;
let siloedTag: Fr;

beforeAll(async () => {
  l2Portal = await AztecAddress.random();
  siloedTag = await computeSiloedWithdrawalTag(l2Portal);
});

// A private log carrying the withdrawal publishing tag, laid out as `extractWithdrawalMessages` reads it:
// [siloedTag, executor, userPayloadHash, amount, proverTip, randomness, recipient, relayerTip, sLo, sHi, rLo, rHi].
const withdrawalLog = () => ({
  fields: [
    siloedTag,
    EthAddress.random().toField(),
    Fr.random(),
    new Fr(1000n),
    new Fr(10n),
    Fr.random(),
    EthAddress.random().toField(),
    new Fr(100n),
    Fr.ZERO,
    Fr.ZERO,
    Fr.ZERO,
    Fr.ZERO,
  ],
});

const observedTx = (
  epoch: number,
  checkpoint: number,
  logs: Array<ReturnType<typeof withdrawalLog>> = [],
): ObservedTx =>
  ({
    epochNumber: EpochNumber(epoch),
    checkpointNumber: CheckpointNumber(checkpoint),
    blockNumber: BlockNumber(10),
    txIndexInBlock: 0,
    txEffect: { privateLogs: logs, txHash: TxHash.random() },
  }) as any;

const txRef = (epoch: number, checkpoint: number): TxRef => ({
  epochNumber: EpochNumber(epoch),
  checkpointNumber: CheckpointNumber(checkpoint),
  blockNumber: BlockNumber(10),
  txHash: TxHash.random(),
});

// Frozen at epoch 2, checkpoint 5, with the outbox filled to depth 5 at the freeze.
const frozenPortal = (onFrozen?: (cb: (event: FrozenEvent) => unknown) => void) =>
  ({
    isFrozen: () => Promise.resolve(true),
    getFreezeCheckpointNumber: () => Promise.resolve(CheckpointNumber(5)),
    getFreezeEpochNumber: () => Promise.resolve(EpochNumber(2)),
    getFreezeCheckpointCount: () => Promise.resolve(5n),
    listenToFrozen: (cb: (event: FrozenEvent) => unknown) => {
      onFrozen?.(cb);
      return () => {};
    },
  }) as any;

const livePortal = () => ({ isFrozen: () => Promise.resolve(false), listenToFrozen: () => () => {} }) as any;

const deps = (portal: any): ProverClaimAdaptorDeps => ({
  node: {} as any,
  portal,
  rollup: {} as any,
  signer: {} as any,
});

const portalContext = () => ({ l2Portal }) as unknown as PortalContext;

describe('ProverClaimDiscoveryAdaptor freeze gating', () => {
  it('discovers a claim on a live portal', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({ portal: livePortal() });
    expect(await adaptor.buildProverClaims(observedTx(9, 9, [withdrawalLog()]), portalContext())).toHaveLength(1);
  });

  it('drops a claim whose burn lands past the freeze boundary', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({ portal: frozenPortal() });
    // A later epoch, and the freeze epoch beyond the freeze checkpoint, are both cut off.
    expect(await adaptor.buildProverClaims(observedTx(3, 1, [withdrawalLog()]), portalContext())).toEqual([]);
    expect(await adaptor.buildProverClaims(observedTx(2, 6, [withdrawalLog()]), portalContext())).toEqual([]);
  });

  it('keeps a claim whose burn is within the freeze boundary', async () => {
    const adaptor = await ProverClaimDiscoveryAdaptor.create({ portal: frozenPortal() });
    // Freeze epoch (2), checkpoint at or before the freeze checkpoint (5): still payable, still discovered.
    expect(await adaptor.buildProverClaims(observedTx(2, 5, [withdrawalLog()]), portalContext())).toHaveLength(1);
  });

  it('drops a claim once a freeze lands after creation', async () => {
    let onFrozen: ((event: FrozenEvent) => unknown) | undefined;
    const portal = {
      isFrozen: () => Promise.resolve(false),
      listenToFrozen: (cb: (event: FrozenEvent) => unknown) => {
        onFrozen = cb;
        return () => {};
      },
    } as any;
    const adaptor = await ProverClaimDiscoveryAdaptor.create({ portal });
    const tx = observedTx(2, 6, [withdrawalLog()]);
    expect(await adaptor.buildProverClaims(tx, portalContext())).toHaveLength(1);

    onFrozen!({
      checkpointNumber: CheckpointNumber(5),
      epochNumber: EpochNumber(2),
      archive: Fr.random(),
      freezeCheckpointCount: 5n,
    });
    expect(await adaptor.buildProverClaims(tx, portalContext())).toEqual([]);
  });
});

describe('ProverClaimAdaptor freeze gating', () => {
  it('does not cut off any claim while the portal is live', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(livePortal()));
    expect(await adaptor.buildProverClaims(observedTx(9, 9, [withdrawalLog()]), portalContext())).toHaveLength(1);
  });

  it('drops a claim whose burn lands past the freeze boundary', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(frozenPortal()));
    // A later epoch, and the freeze epoch beyond the freeze checkpoint, are both cut off.
    expect(await adaptor.buildProverClaims(observedTx(3, 1, [withdrawalLog()]), portalContext())).toEqual([]);
    expect(await adaptor.buildProverClaims(observedTx(2, 6, [withdrawalLog()]), portalContext())).toEqual([]);
  });

  it('keeps a claim whose burn is within the freeze boundary', async () => {
    const adaptor = await ProverClaimAdaptor.create(deps(frozenPortal()));
    // Freeze epoch (2), checkpoint at or before the freeze checkpoint (5).
    expect(await adaptor.buildProverClaims(observedTx(2, 5, [withdrawalLog()]), portalContext())).toHaveLength(1);
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
    expect(await adaptor.buildProverClaims(observedTx(2, 6, [withdrawalLog()]), portalContext())).toEqual([]);
  });
});
