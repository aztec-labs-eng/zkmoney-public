import { BlockNumber, CheckpointNumber, EpochNumber } from '@aztec/foundation/branded-types';
import { Checkpoint } from '@aztec/stdlib/checkpoint';
import { AztecNode, ProverNodeApi } from '@aztec/stdlib/interfaces/server';

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { PartialEpochProofStarter, PartialEpochProofStarterOptions } from './partial_epoch_proof_starter.js';
import { PartialProofDecision, PartialProofPolicy } from './types.js';

describe('PartialEpochProofStarter', () => {
  const epoch = EpochNumber(1);
  // The epoch's full checkpoint chain. Evaluated prefix: 1..2. Extended (synced) prefix: 1..3.
  const cp = (n: number): Checkpoint => ({ number: CheckpointNumber(n) }) as unknown as Checkpoint;
  const chain = [cp(1), cp(2), cp(3), cp(4)];
  const evaluated = chain.slice(0, 2);
  const lastCheckpoint = 2;
  const extended = chain.slice(0, 3);

  let shouldSubmit: jest.Mock<(input: { checkpoints: Checkpoint[] }) => Promise<PartialProofDecision>>;
  let startProof: jest.Mock<() => Promise<string>>;
  let getJobs: jest.Mock<() => Promise<{ uuid: string; status: string; epochNumber: EpochNumber }[]>>;
  let getChainTips: jest.Mock<() => Promise<any>>;
  let onError: jest.Mock<(error: unknown) => void>;
  let jobs: { uuid: string; status: string; epochNumber: EpochNumber }[];
  let tip: number;

  const makeStarter = (timings: { completionTimeoutMs?: number } = {}) => {
    const policy = { shouldSubmit } as unknown as PartialProofPolicy;
    const node = { getChainTips } as unknown as AztecNode;
    const proverNode = {
      startProof,
      getJobs,
    } as unknown as ProverNodeApi;

    const options: PartialEpochProofStarterOptions = {
      node,
      partialProofPolicy: policy,
      proverNode,
      epochDuration: 32,
      fromBlock: BlockNumber(0),
      onError,
      timings: {
        settleDelayMs: 1,
        completionPollIntervalMs: 1,
        completionTimeoutMs: 1_000,
        ...timings,
      },
    };
    const starter = new PartialEpochProofStarter(options);
    // Stub the checkpoint fetch; the full plumbing is CheckpointSource's concern.
    (starter as any).source.getEpochPrefix = (_epoch: EpochNumber, latest: CheckpointNumber) =>
      Promise.resolve(chain.filter(c => c.number <= latest));
    return starter;
  };

  // Drive one evaluation to completion via the private handler + worker.
  const run = async (starter: PartialEpochProofStarter, checkpoints: Checkpoint[]) => {
    (starter as any).onEpochCheckpoints(epoch, checkpoints);
    await (starter as any).worker;
  };

  beforeEach(() => {
    jobs = [];
    tip = lastCheckpoint;
    shouldSubmit = jest.fn(() => Promise.resolve({ submit: true }));
    onError = jest.fn();
    getJobs = jest.fn(() => Promise.resolve(jobs));
    // Each started proof appears as a completed job, so the completion wait exits immediately.
    startProof = jest.fn(() => {
      const uuid = `job-${jobs.length + 1}`;
      jobs.push({ uuid, status: 'completed', epochNumber: epoch });
      return Promise.resolve(uuid);
    });
    getChainTips = jest.fn(() => Promise.resolve({ checkpointed: { checkpoint: { number: CheckpointNumber(tip) } } }));
  });

  it('re-prices the synced prefix and proves it when the tip advanced and re-evaluation says submit', async () => {
    tip = 3;
    const starter = makeStarter();
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(2);
    expect(shouldSubmit.mock.calls[1][0].checkpoints).toHaveLength(extended.length);
    expect(startProof).toHaveBeenCalledTimes(1);
  });

  it('does not prove when the tip advanced but re-evaluation says wait', async () => {
    tip = 3;
    const starter = makeStarter();
    shouldSubmit
      .mockImplementationOnce(() => Promise.resolve({ submit: true }))
      .mockImplementationOnce(() => Promise.resolve({ submit: false }));
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(2);
    expect(startProof).not.toHaveBeenCalled();
  });

  it('proves without re-evaluating when the tip equals the evaluated last checkpoint', async () => {
    tip = lastCheckpoint;
    const starter = makeStarter();
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(1);
    expect(startProof).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the initial evaluation says wait', async () => {
    const starter = makeStarter();
    shouldSubmit.mockImplementation(() => Promise.resolve({ submit: false }));
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(1);
    expect(getChainTips).not.toHaveBeenCalled();
    expect(startProof).not.toHaveBeenCalled();
  });

  it('skips a redelivered prefix the policy already declined', async () => {
    const starter = makeStarter();
    shouldSubmit.mockImplementation(() => Promise.resolve({ submit: false }));
    await run(starter, evaluated);
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(1);
    expect(startProof).not.toHaveBeenCalled();
  });

  it('skips a redelivered prefix the tip-extension re-price already decided on', async () => {
    tip = 3;
    const starter = makeStarter();
    await run(starter, evaluated);
    await run(starter, extended);

    expect(shouldSubmit).toHaveBeenCalledTimes(2);
    expect(startProof).toHaveBeenCalledTimes(1);
  });

  it('evaluates a prefix extending past the already-evaluated tip', async () => {
    tip = 3;
    const starter = makeStarter();
    await run(starter, evaluated);
    tip = 4;
    await run(starter, [...extended, cp(4)]);

    expect(shouldSubmit).toHaveBeenCalledTimes(3);
    expect(startProof).toHaveBeenCalledTimes(2);
  });

  it('keeps re-pricing until the tip is stable', async () => {
    tip = 3;
    const starter = makeStarter();
    shouldSubmit.mockImplementation(input => {
      // A new checkpoint lands while the first re-evaluation runs.
      if ((input as any).checkpoints.length === 3) {
        tip = 4;
      }
      return Promise.resolve({ submit: true });
    });
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(3);
    expect(shouldSubmit.mock.calls[2][0].checkpoints).toHaveLength(4);
    expect(startProof).toHaveBeenCalledTimes(1);
  });

  it('stops extending at the epoch boundary when the tip is beyond it', async () => {
    tip = 5;
    const starter = makeStarter();
    await run(starter, evaluated);

    expect(shouldSubmit).toHaveBeenCalledTimes(2);
    expect(shouldSubmit.mock.calls[1][0].checkpoints).toHaveLength(chain.length);
    expect(startProof).toHaveBeenCalledTimes(1);
  });

  it('treats the started job disappearing from getJobs as completion', async () => {
    // The prover node prunes a terminal job on its next reconcile, so a successful proof leaves no
    // trace in getJobs. The wait must exit on the job's absence rather than polling to the timeout —
    // a single empty poll settles it, so getJobs is hit far fewer than timeout/pollInterval times.
    startProof = jest.fn(() => Promise.resolve('job-gone'));
    const starter = makeStarter();
    await run(starter, evaluated);

    expect(startProof).toHaveBeenCalledTimes(1);
    expect(getJobs.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('treats a completion-wait timeout as a warning, not an error', async () => {
    // The job never leaves a non-terminal state, so the wait runs out. A slow proof is not a failure: the worker
    // must move on without reporting an error.
    startProof = jest.fn(() => {
      jobs.push({ uuid: 'job-stuck', status: 'awaiting-checkpoints', epochNumber: epoch });
      return Promise.resolve('job-stuck');
    });
    const starter = makeStarter({ completionTimeoutMs: 20 });
    await run(starter, evaluated);

    expect(startProof).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('re-evaluates a previously decided prefix after a reorg', async () => {
    tip = 3;
    const starter = makeStarter();
    await run(starter, evaluated);
    await (starter as any).onChainPruned(BlockNumber(0));
    await run(starter, extended);

    expect(shouldSubmit).toHaveBeenCalledTimes(3);
    expect(startProof).toHaveBeenCalledTimes(2);
  });
});
