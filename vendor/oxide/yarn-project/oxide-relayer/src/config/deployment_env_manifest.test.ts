import { AztecAddress } from '@aztec/aztec.js/addresses';
import { EthAddress } from '@aztec/foundation/eth-address';

import { describe, expect, it } from '@jest/globals';

import { resolveDeploymentEnvManifest } from './deployment_env_manifest.js';

const URL = 'https://manifest.example/prod.v4.json';
const PORTAL = '0x0000000000000000000000000000000000000001';
const OTHER_PORTAL = '0x0000000000000000000000000000000000000010';
const THIRD_PORTAL = '0x0000000000000000000000000000000000000011';
const L2_TOKEN = '0x' + '11'.repeat(32);
const BROADCASTER = '0x' + '22'.repeat(32);
const OPERATION_EXECUTOR = '0x0000000000000000000000000000000000000004';
const PLAIN_WITHDRAWAL_EXECUTOR = '0x0000000000000000000000000000000000000009';
const ENCLAVE_URL = 'https://enclave.example/rpc';
const WITHDRAWAL_SUBSIDY = '0x0000000000000000000000000000000000000005';
const PROVER_SUBSIDY = '0x000000000000000000000000000000000000000a';
const FPC_FUNDER = '0x0000000000000000000000000000000000000007';

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: 'v4',
    withdrawalProtocol: 'l1-operation',
    portal: PORTAL,
    l2Token: L2_TOKEN,
    rollupVersion: '4',
    enclaveUrl: ENCLAVE_URL,
    l2Broadcaster: BROADCASTER,
    withdrawalSubsidy: WITHDRAWAL_SUBSIDY,
    proverSubsidy: PROVER_SUBSIDY,
    plainWithdrawalExecutor: PLAIN_WITHDRAWAL_EXECUTOR,
    operationExecutor: OPERATION_EXECUTOR,
    fpcFunder: FPC_FUNDER,
    ...overrides,
  };
}

function document(...deployments: Record<string, unknown>[]): string {
  return JSON.stringify({ schemaVersion: '4', deployments });
}

function resolve(body: string, portal = PORTAL) {
  const fetchImpl = () => Promise.resolve(new Response(body, { status: 200 }));
  return resolveDeploymentEnvManifest({
    deploymentEnvManifestUrl: URL,
    portal: EthAddress.fromString(portal),
    fetch: fetchImpl as typeof fetch,
  });
}

describe('resolveDeploymentEnvManifest', () => {
  it('pins the entry by portal (any case) and reads every field from the entry itself', async () => {
    const { current } = await resolve(document(entry()), PORTAL.toUpperCase().replace('0X', '0x'));
    const { publicConfig } = current;

    expect(current.label).toBe('v4');
    expect(publicConfig.portal).toBeInstanceOf(EthAddress);
    expect(publicConfig.portal.toString()).toBe(PORTAL);
    expect(publicConfig.l2Token).toBeInstanceOf(AztecAddress);
    expect(publicConfig.rollupVersion).toBe(4n);
    expect(publicConfig.enclaveUrl).toBe(ENCLAVE_URL);
    expect(publicConfig.broadcaster.toString()).toBe(BROADCASTER);
    expect(publicConfig.withdrawalSubsidy.toString()).toBe(WITHDRAWAL_SUBSIDY);
    expect(publicConfig.proverSubsidy.toString()).toBe(PROVER_SUBSIDY);
    expect(publicConfig.plainWithdrawalExecutor.toString()).toBe(PLAIN_WITHDRAWAL_EXECUTOR);
    expect(publicConfig.operationExecutor.toString()).toBe(OPERATION_EXECUTOR);
    expect(publicConfig.fpcFunder.toString()).toBe(FPC_FUNDER);
  });

  it('throws when the withdrawal subsidy is absent', async () => {
    const { withdrawalSubsidy: _dropped, ...noWithdrawal } = entry();
    await expect(resolve(document(noWithdrawal))).rejects.toThrow(/\(v4\): withdrawalSubsidy missing/);
  });

  it('throws when the prover subsidy is absent', async () => {
    const { proverSubsidy: _dropped, ...noProver } = entry();
    await expect(resolve(document(noProver))).rejects.toThrow(/\(v4\): proverSubsidy missing/);
  });

  it('throws when the pinned portal is absent, listing the available deployments', async () => {
    await expect(resolve(document(entry()), OTHER_PORTAL)).rejects.toThrow(
      new RegExp(`no deployment with portal ${OTHER_PORTAL} \\(available: v4:${PORTAL}\\)`),
    );
  });

  it('throws on a v3 document at the v4 URL', async () => {
    const v3 = JSON.stringify({ schemaVersion: '3', shared: {}, versions: {} });
    await expect(resolve(v3)).rejects.toThrow(/unsupported schemaVersion "3" \(want "4"/);
  });

  it('pins the requested portal and selects historical entries on the same rollup', async () => {
    const v5 = entry({ label: 'v5', portal: OTHER_PORTAL });
    const v6 = entry({ label: 'v6', portal: THIRD_PORTAL, rollupVersion: '5' });
    const manifest = await resolve(document(v6, entry(), v5));
    expect(manifest.current.label).toBe('v4');
    expect(manifest.current.publicConfig.portal.toString()).toBe(PORTAL);
    expect(manifest.historical.map(d => d.publicConfig.portal.toString())).toEqual([OTHER_PORTAL]);
  });

  it('rejects a document with two entries that share a portal, whatever its case, naming both', async () => {
    const upper = OTHER_PORTAL.toUpperCase().replace('0X', '0x');
    const other = entry({ label: 'v5', portal: OTHER_PORTAL });
    const otherUpper = entry({ label: 'v6', portal: upper, rollupVersion: '9' });
    await expect(resolve(document(entry(), other, otherUpper))).rejects.toThrow(
      `deployment env manifest ${URL} has two deployments with portal ${OTHER_PORTAL}: v5:${OTHER_PORTAL} and v6:${upper}.`,
    );
  });

  it('rejects a document with two entries that share a label, naming both', async () => {
    const other = entry({ label: 'v4', portal: OTHER_PORTAL, rollupVersion: '9' });
    await expect(resolve(document(entry(), other))).rejects.toThrow(
      `deployment env manifest ${URL} has two deployments with label v4: v4:${PORTAL} and v4:${OTHER_PORTAL}.`,
    );
  });

  it('is fatal when the pinned entry is malformed, naming the URL, the entry and the field', async () => {
    await expect(resolve(document(entry({ rollupVersion: '' })))).rejects.toThrow(
      `deployment env manifest ${URL}: deployment ${PORTAL} (v4): rollupVersion "": not a decimal integer`,
    );
    await expect(resolve(document(entry({ operationExecutor: 'garbage' })))).rejects.toThrow(
      /deployment .* \(v4\): operationExecutor "garbage": /,
    );
    const { fpcFunder: _dropped, ...noFunder } = entry();
    await expect(resolve(document(noFunder))).rejects.toThrow(/deployment .* \(v4\): fpcFunder missing/);
  });

  it('is fatal when a non-pinned entry is malformed, on any rollup version', async () => {
    const badRollup = entry({ label: 'v8', portal: OTHER_PORTAL, rollupVersion: 'x' });
    await expect(resolve(document(entry(), badRollup))).rejects.toThrow(
      `deployment env manifest ${URL}: deployment ${OTHER_PORTAL} (v8): rollupVersion "x": not a decimal integer`,
    );
    const { operationExecutor: _dropped, ...noExecutor } = entry({
      label: 'v9',
      portal: THIRD_PORTAL,
      rollupVersion: '9',
    });
    await expect(resolve(document(entry(), noExecutor))).rejects.toThrow(
      `deployment env manifest ${URL}: deployment ${THIRD_PORTAL} (v9): operationExecutor missing`,
    );
    await expect(resolve(document(entry(), { label: 'v10' }))).rejects.toThrow(
      /deployment \(no portal\) \(v10\): portal missing/,
    );
  });
});

describe('historical L1-operation deployment selection', () => {
  it.each([undefined, 'legacy', 'unknown'])(
    'skips historical protocol %s while retaining modern entries',
    async withdrawalProtocol => {
      const result = await resolve(
        document(
          entry({ withdrawalProtocol: undefined }),
          entry({ label: 'old', portal: OTHER_PORTAL, withdrawalProtocol }),
          entry({ label: 'compatible', portal: THIRD_PORTAL }),
        ),
      );
      expect(result.current.publicConfig.portal.toString()).toBe(PORTAL);
      expect(result.historical.map(d => d.publicConfig.portal.toString())).toEqual([THIRD_PORTAL]);
    },
  );

  it.each([false, true])('uses rollup and portal, not labels or entry order (reversed=%s)', async reverse => {
    const entries = [
      entry({ label: 'z-current' }),
      entry({ label: 'unrelated-name', portal: OTHER_PORTAL }),
      entry({ label: 'a-new', portal: THIRD_PORTAL, rollupVersion: '99' }),
    ];
    const result = await resolve(document(...(reverse ? entries.reverse() : entries)));
    expect(result.current.publicConfig.portal.toString()).toBe(PORTAL);
    expect(result.historical.map(d => d.publicConfig.portal.toString())).toEqual([OTHER_PORTAL]);
  });
});
