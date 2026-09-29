import { describe, expect, it, jest } from '@jest/globals';

import { type HistoricalDeploymentHandle, HistoricalDeploymentSupervisor } from './historical_deployment_supervisor.js';

function handle(): HistoricalDeploymentHandle & { stop: jest.Mock; close: jest.Mock } {
  return { stop: jest.fn(() => Promise.resolve()), close: jest.fn(() => Promise.resolve()) };
}

function logger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

describe('HistoricalDeploymentSupervisor', () => {
  it('starts after bounded retries with increasing delays', async () => {
    const started = handle();
    const start = jest
      .fn<() => Promise<HistoricalDeploymentHandle>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue(started);
    const delay = jest.fn<(_ms: number, _signal: AbortSignal) => Promise<void>>(() => Promise.resolve());
    const log = logger();
    const supervisor = new HistoricalDeploymentSupervisor({
      label: 'v5',
      portal: '0x1',
      start,
      retryDelaysMs: [15, 60, 300],
      delay,
      log,
    });

    supervisor.start();
    await supervisor.wait();

    expect(start).toHaveBeenCalledTimes(3);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([15, 60]);
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('attempt=3'));
    await supervisor.stop();
    await supervisor.close();
    expect(started.stop).toHaveBeenCalledTimes(1);
    expect(started.close).toHaveBeenCalledTimes(1);
  });

  it('gives up after the final attempt and logs the coverage gap', async () => {
    const start = jest.fn<() => Promise<HistoricalDeploymentHandle>>().mockRejectedValue(new Error('unavailable'));
    const delay = jest.fn<(_ms: number, _signal: AbortSignal) => Promise<void>>(() => Promise.resolve());
    const log = logger();
    const supervisor = new HistoricalDeploymentSupervisor({
      label: 'v5',
      portal: '0x1',
      start,
      retryDelaysMs: [15, 60, 300],
      delay,
      log,
    });

    supervisor.start();
    await supervisor.wait();

    expect(start).toHaveBeenCalledTimes(4);
    expect(delay.mock.calls.map(([ms]) => ms)).toEqual([15, 60, 300]);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('disabled until restart'));
  });

  it('cancels a pending retry during shutdown', async () => {
    const start = jest.fn<() => Promise<HistoricalDeploymentHandle>>().mockRejectedValue(new Error('unavailable'));
    const delay = jest.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
    );
    const supervisor = new HistoricalDeploymentSupervisor({
      label: 'v5',
      portal: '0x1',
      start,
      retryDelaysMs: [15, 60, 300],
      delay,
      log: logger(),
    });

    supervisor.start();
    await Promise.resolve();
    await supervisor.stop();

    expect(start).toHaveBeenCalledTimes(1);
  });
});

it('stops and closes a worker that finishes startup during shutdown', async () => {
  let complete!: (value: HistoricalDeploymentHandle) => void;
  const started = handle();
  const supervisor = new HistoricalDeploymentSupervisor({
    label: 'anything',
    portal: '0x1',
    log: logger(),
    start: () =>
      new Promise(resolve => {
        complete = resolve;
      }),
  });
  supervisor.start();
  const stopped = supervisor.stop();
  complete(started);
  await stopped;
  await supervisor.close();
  expect(started.stop).toHaveBeenCalledTimes(1);
  expect(started.close).toHaveBeenCalledTimes(1);
});
