import { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';

import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { statePathForPortal } from '../state/path.js';
import { type ResolvedManifestDeployment, resolveDeploymentEnvManifest } from './deployment_env_manifest.js';
import { DeploymentManifestRefresher, MANIFEST_REFRESH_INTERVAL_MS } from './deployment_manifest_refresher.js';

function entry(id: number, overrides: Record<string, unknown> = {}) {
  return {
    label: `v${id}`,
    portal: `0x${id.toString(16).padStart(40, '0')}`,
    withdrawalProtocol: 'l1-operation',
    rollupVersion: '4',
    l2Token: '0x' + '11'.repeat(32),
    token: '0x' + '06'.repeat(20),
    l2Broadcaster: '0x' + '22'.repeat(32),
    enclaveUrl: 'https://enclave.example/rpc',
    withdrawalSubsidy: '0x' + '01'.repeat(20),
    proverSubsidy: '0x' + '04'.repeat(20),
    plainWithdrawalExecutor: '0x' + '05'.repeat(20),
    operationExecutor: '0x' + '02'.repeat(20),
    fpcFunder: '0x' + '03'.repeat(20),
    ...overrides,
  };
}

/** An entry that the relayer watches but cannot read: it has only the fields that select it. */
function unreadable(id: number): Record<string, unknown> {
  const { label, portal, withdrawalProtocol, rollupVersion } = entry(id);
  return { label, portal, withdrawalProtocol, rollupVersion };
}

async function setup(...initialEntries: Record<string, unknown>[]) {
  let entries = initialEntries.length ? initialEntries : [entry(2), entry(1)];
  const fetchImpl = jest.fn<typeof fetch>(() =>
    Promise.resolve(new Response(JSON.stringify({ schemaVersion: '4', deployments: entries }))),
  );
  const initial = await resolveDeploymentEnvManifest({
    deploymentEnvManifestUrl: 'https://manifest.example/prod.v4.json',
    portal: EthAddress.fromString(entry(2).portal),
    fetch: fetchImpl,
  });
  const discover = jest.fn<(deployment: ResolvedManifestDeployment) => void>();
  const logger = createLogger('test:manifest');
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const refresher = new DeploymentManifestRefresher({
    deploymentEnvManifestUrl: 'https://manifest.example/prod.v4.json',
    initial,
    discover,
    fetch: fetchImpl,
    logger,
  });
  return { refresher, initial, fetchImpl, discover, warn, publish: (...next: typeof entries) => (entries = next) };
}

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('DeploymentManifestRefresher', () => {
  it('adds compatible portals once without changing the pinned deployment', async () => {
    const { refresher, initial, publish, discover } = await setup();
    const current = initial.current;
    publish(
      entry(4, { label: 'a-new' }),
      entry(2),
      entry(3, { label: 'z-old' }),
      entry(1),
      entry(5, { rollupVersion: '5' }),
      entry(6, { withdrawalProtocol: 'legacy' }),
      entry(7, { withdrawalProtocol: undefined }),
    );
    await refresher.runOnce();
    await refresher.runOnce();
    expect(discover.mock.calls.map(([d]) => d.label)).toEqual(['a-new', 'z-old']);
    expect(initial.current).toBe(current);
    expect(initial.current.publicConfig.portal.toString()).toBe(entry(2).portal);
    publish(entry(2), entry(1));
    await refresher.runOnce();
    publish(entry(2), entry(4), entry(3));
    await refresher.runOnce();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('recovers after network, HTTP, and malformed manifest failures', async () => {
    const { refresher, publish, fetchImpl, discover, warn } = await setup();
    fetchImpl.mockRejectedValueOnce(new Error('offline'));
    await refresher.runOnce();
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 }));
    await refresher.runOnce();
    fetchImpl.mockResolvedValueOnce(new Response('{'));
    await refresher.runOnce();
    publish(entry(2, { operationExecutor: undefined }), entry(3));
    await refresher.runOnce();
    expect(discover).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(4);
    publish(entry(2), entry(3));
    await refresher.runOnce();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('adds a new deployment while the manifest holds a deployment it cannot read', async () => {
    const { refresher, publish, discover, warn } = await setup(entry(2));
    publish(entry(2), unreadable(3), entry(4));
    await refresher.runOnce();
    expect(discover.mock.calls.map(([d]) => d.label)).toEqual(['v4']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^Not watching a deployment: .* \(v3\): /));
  });

  it('adds a deployment it could not read once the manifest has a readable entry for it', async () => {
    const { refresher, publish, discover } = await setup(entry(2), unreadable(3));
    await refresher.runOnce();
    publish(entry(2), entry(3));
    await refresher.runOnce();
    expect(discover.mock.calls.map(([d]) => d.label)).toEqual(['v3']);
  });

  it('warns once at startup about a deployment it cannot read', async () => {
    const { refresher, warn } = await setup(entry(2), unreadable(3));
    jest.useFakeTimers();
    refresher.start();
    try {
      await jest.advanceTimersByTimeAsync(0);
      expect(warn.mock.calls).toEqual([[expect.stringMatching(/^Not watching a deployment: .* \(v3\): /)]]);
    } finally {
      await refresher.stop();
    }
  });

  it('rejects a missing startup portal or changed startup rollup before adding workers', async () => {
    const { refresher, publish, discover, warn } = await setup();
    publish(entry(3));
    await refresher.runOnce();
    publish(entry(2, { rollupVersion: '5' }), entry(3, { rollupVersion: '5' }));
    await refresher.runOnce();
    expect(discover).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    publish(entry(2), entry(3));
    await refresher.runOnce();
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('retries failed registration without registering previous workers again', async () => {
    const { refresher, publish, discover } = await setup();
    publish(entry(2), entry(3), entry(4));
    discover
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('cannot register');
      });
    await refresher.runOnce();
    await refresher.runOnce();
    expect(discover.mock.calls.map(([d]) => d.label)).toEqual(['v3', 'v4', 'v4']);
  });

  it('rejects a literal state path for a new worker and retries at the next refresh', async () => {
    const { refresher, publish, discover, warn } = await setup(entry(2));
    publish(entry(2), entry(3));
    discover.mockImplementation(deployment => {
      statePathForPortal('/data/relayer.sqlite3', deployment.publicConfig.portal, 2);
    });
    await refresher.runOnce();
    await refresher.runOnce();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('state path must contain {portal}'));
  });

  it('polls for deployments and stops polling on shutdown', async () => {
    const { refresher, publish, fetchImpl, discover } = await setup();
    jest.useFakeTimers();
    refresher.start();
    try {
      await jest.advanceTimersByTimeAsync(0);
      publish(entry(2), entry(3));
      await jest.advanceTimersByTimeAsync(MANIFEST_REFRESH_INTERVAL_MS);
      expect(discover).toHaveBeenCalledTimes(1);
    } finally {
      await refresher.stop();
    }
    const calls = fetchImpl.mock.calls.length;
    await jest.advanceTimersByTimeAsync(MANIFEST_REFRESH_INTERVAL_MS * 2);
    await refresher.runOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(calls);
  });

  it('aborts a pending fetch on shutdown without adding workers', async () => {
    const { refresher, fetchImpl, discover, warn } = await setup();
    let signal: AbortSignal | undefined;
    fetchImpl.mockImplementationOnce(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          signal = init?.signal ?? undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    refresher.start();
    await refresher.stop();
    expect(signal?.aborted).toBe(true);
    expect(discover).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not add workers if a fetch completes after shutdown starts', async () => {
    const { refresher, fetchImpl, discover } = await setup();
    let complete!: (response: Response) => void;
    fetchImpl.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          complete = resolve;
        }),
    );
    refresher.start();
    const stopping = refresher.stop();
    complete(new Response(JSON.stringify({ schemaVersion: '4', deployments: [entry(2), entry(3)] })));
    await stopping;
    expect(discover).not.toHaveBeenCalled();
  });
});
