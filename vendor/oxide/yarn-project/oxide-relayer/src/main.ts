import type { ViemPublicClient } from '@aztec/ethereum/types';
import type { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';

import { OxidePortalContract, depositTokensFor } from '@oxide/l1-contracts';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';
import { initTelemetry } from '@oxide/telemetry';
import { OFAC_SDN_LIST_URL, OfacSdnList } from '@oxide/watcher-lib/sanctions';

import { erc20Abi, zeroAddress } from 'viem';

import type { RunConfig } from './cli/config.js';
import { type ResolvedManifestDeployment, resolveDeploymentEnvManifest } from './config/deployment_env_manifest.js';
import { FpcFunderCaller } from './fpc_funding/fpc_funder_caller.js';
import { HistoricalDeploymentSupervisor } from './historical_deployment_supervisor.js';
import { L1OperationRelayer } from './l1_operations/l1_operation_relayer.js';
import { WithdrawalCompletion } from './l1_operations/withdrawal_completion.js';
import { assertNotFlashbots } from './l1_submission_rpc.js';
import { getL1PublicClient } from './l1_utils.js';
import { ChainlinkPriceOracle } from './price_oracle/chainlink_price_oracle.js';
import { startEpochProofs } from './prover/index.js';
import { RelayerL1SubmissionBatcher } from './relayer_l1_submission_batcher.js';
import { type RelayerL1TxUtils, createRelayerL1TxUtils } from './relayer_l1_tx_utils.js';
import { createRelayerSubmission } from './relayer_submission.js';
import { RelayerTelemetry } from './relayer_telemetry.js';
import { type LoadedSigner, loadSigner } from './signers/index.js';
import { statePathForPortal } from './state/path.js';
import { type SqliteStateStore, openSqliteStateStore } from './state/sqlite_store.js';

/**
 * Bootstrap the long-running relayer process.
 */
export interface RunRelayerOptions {
  shutdownSignal?: AbortSignal;
  teeSigner?: TeeSigner;
}

/** Bounded final telemetry flush on shutdown, so a hung exporter cannot block exit. */
const TELEMETRY_STOP_MS = 5_000;

export async function runRelayer(config: RunConfig, opts: RunRelayerOptions = {}): Promise<void> {
  // Assert read URL is not mistakenly set to Flashbots
  assertNotFlashbots(config.readL1RpcUrl);

  const manifest = await resolveDeploymentEnvManifest({
    deploymentEnvManifestUrl: config.deploymentEnvManifestUrl,
    portal: config.portal,
  });
  const currentPublicConfig = manifest.current.publicConfig;
  const historical = config.modes.includes('l1-operations') ? manifest.historical : [];
  const currentStatePath = statePathForPortal(
    config.state.sqlitePath,
    currentPublicConfig.portal,
    historical.length + 1,
  );
  const historicalPaths = historical.map(deployment => ({
    deployment,
    path: statePathForPortal(config.state.sqlitePath, deployment.publicConfig.portal, historical.length + 1),
  }));

  const node = createNodeClient({ url: config.aztecNodeUrl, apiKey: config.aztecNodeApiKey });
  const { publicClient, chainId } = await getL1PublicClient(config.readL1RpcUrl, node);
  const identity = ({ publicConfig }: ResolvedManifestDeployment) => ({
    chainId,
    portal: publicConfig.portal.toString(),
    l2Token: publicConfig.l2Token.toString(),
    rollupVersion: publicConfig.rollupVersion,
    ...(config.modes.includes('l1-operations') ? { broadcaster: publicConfig.broadcaster.toString() } : {}),
  });

  let signer: LoadedSigner | undefined;
  let l1TxUtils: RelayerL1TxUtils | undefined;
  let l1SubmissionBatcher: RelayerL1SubmissionBatcher | undefined;
  // Unset on a chain with no Protect endpoint, where submission shares the read RPC and there is no split.
  let submissionHost: string | undefined;
  if (!config.disableSubmission) {
    signer = await loadSigner(config.signer);
    const submission = createRelayerSubmission({
      chainId,
      flashbotsBlockRange: config.flashbotsBlockRange,
      l1MinPriorityFeeGwei: config.l1MinPriorityFeeGwei,
      readL1RpcUrl: config.readL1RpcUrl,
      account: signer.account,
      chain: publicClient.chain,
    });
    submissionHost = submission.submissionHost;
    l1TxUtils = createRelayerL1TxUtils(submission.client, submission.txUtilsConfig, submission.protectTxStatusUrl);
    l1SubmissionBatcher = new RelayerL1SubmissionBatcher({
      l1TxUtils,
      blockWindow: config.flashbotsBlockRange,
    });
  }

  // Endpoint arrives through the standard OTel env vars set by the deploy; external operators set nothing
  // and every instrument is a no-op. The pinned entry's label is service.version.
  const telemetryClient = await initTelemetry({
    serviceName: 'oxide-relayer',
    serviceVersion: manifest.current.label,
  });
  const telemetry = new RelayerTelemetry(telemetryClient);

  let sdn: OfacSdnList | undefined;
  let state: SqliteStateStore | undefined;
  const historicalSupervisors: HistoricalDeploymentSupervisor[] = [];
  const operationStores = new Set<SqliteStateStore>();
  const currentServices: Array<{ stop(): Promise<void> }> = [];
  try {
    if (config.modes.includes('l1-operations') && !config.disableSubmission) {
      const list = await OfacSdnList.start(config.sdnUrl);
      sdn = list;
      telemetry.observeSdnListAge(() => list.lastRefreshedAt);
    }
    state = await openSqliteStateStore(currentStatePath, identity(manifest.current));
    const priceOracle = new ChainlinkPriceOracle(publicClient, { chainId });
    console.log(
      [
        `oxide-relayer starting label=${manifest.current.label}`,
        `modes=${config.modes.join(',')}`,
        // Hostnames only: the read RPC URL embeds a provider API key.
        `l1ReadRpc=${rpcHost(config.readL1RpcUrl)}`,
        `l1SubmissionRpc=${submissionHost ?? '(none)'}`,
        `portal=${currentPublicConfig.portal}`,
        `rollupVersion=${currentPublicConfig.rollupVersion}`,
        `aztecNodeUrl=${config.aztecNodeUrl}`,
        `aztecNodeApiKey=${config.aztecNodeApiKey ? '(configured)' : '(none)'}`,
        `enclaveUrl=${currentPublicConfig.enclaveUrl || '(none)'}`,
        `state=${currentStatePath}`,
        signer ? `signer=${signer.backend}:${signer.address}` : 'signer=disabled',
        `submission=${config.disableSubmission ? 'disabled' : 'enabled'}`,
        `priceFeed=${priceOracle.feed.toString()}`,
        `sdn=${sdn ? rpcHost(config.sdnUrl ?? OFAC_SDN_LIST_URL) : '(none)'}`,
        `l1OperationScreening=${
          config.modes.includes('l1-operations') && !config.disableSubmission ? 'enabled' : 'disabled'
        }`,
      ].join(' '),
    );

    if (config.disableSubmission) {
      console.log('submission kill switch is active; relayer will not sign or broadcast L1 transactions.');
    }

    if (signer) {
      // Capture the address in a const: `signer` is a `let` and would not narrow inside the observer closure.
      const { address } = signer;
      telemetry.observeSignerBalance(() => publicClient.getBalance({ address }));
    }
    if (config.modes.includes('l1-operations')) {
      const sum = async (counts: Iterable<Promise<number>>) => (await Promise.all(counts)).reduce((a, b) => a + b, 0);
      telemetry.observeL1OperationBacklog(() =>
        sum([...operationStores].map(async store => (await store.listPendingL1Operations()).length)),
      );
      telemetry.observeL1OperationWaiting(() =>
        sum(
          [...operationStores].map(async store => {
            const [balance, outbox] = await Promise.all([
              store.listWaitingL1Operations(L1OperationConditionKind.Balance),
              store.listWaitingL1Operations(L1OperationConditionKind.MessageInOutbox),
            ]);
            return balance.length + outbox.length;
          }),
        ),
      );
      if (config.l1OperationsSubmission && !config.disableSubmission) {
        await assertSimulateV1Supported(publicClient, config.readL1RpcUrl);
      }
      const start = async (deployment: ResolvedManifestDeployment, store: SqliteStateStore) => {
        const { publicConfig, label } = deployment;
        const portal = new OxidePortalContract(publicClient, publicConfig.portal);
        const deploymentPayoutToken = await readPayoutToken(publicClient, portal);
        if (!opts.teeSigner && !publicConfig.enclaveUrl) {
          throw new Error(`no enclave is published for deployment ${label}:${publicConfig.portal}`);
        }
        const withdrawalSigner = opts.teeSigner ?? (await FleetSigner.connect(publicConfig.enclaveUrl, portal));
        const worker = L1OperationRelayer.create({
          node,
          publicClient,
          store,
          broadcaster: publicConfig.broadcaster,
          payoutToken: deploymentPayoutToken,
          supportedTokens: depositTokensFor(chainId, deploymentPayoutToken),
          l1OperationsSubmission: config.disableSubmission ? undefined : config.l1OperationsSubmission,
          allowUnprofitable: config.allowUnprofitable,
          executor: publicConfig.operationExecutor,
          l1TxUtils,
          l1SubmissionBatcher,
          sanctionsList: sdn,
          withdrawalCompletion: new WithdrawalCompletion(
            node,
            portal,
            publicConfig.l2Token,
            withdrawalSigner,
            publicConfig.plainWithdrawalExecutor,
            publicConfig.operationExecutor,
            publicConfig.withdrawalSubsidy,
          ),
          predicate: config.predicate,
          logScanWindow: config.logScanWindow,
          priceOracle,
          telemetry,
          pollIntervalMs: config.l1OperationsPollIntervalMs,
          logger: createLogger(`oxide-relayer:${label}:${publicConfig.portal.toString().toLowerCase()}`),
        });
        worker.start();
        operationStores.add(store);
        return worker;
      };
      currentServices.push(await start(manifest.current, state));
      for (const { deployment, path } of historicalPaths) {
        const supervisor = new HistoricalDeploymentSupervisor({
          label: deployment.label,
          portal: deployment.publicConfig.portal.toString(),
          start: async () => {
            const historicalState = await openSqliteStateStore(path, identity(deployment));
            try {
              const worker = await start(deployment, historicalState);
              return {
                stop: () => worker.stop(),
                close: async () => {
                  operationStores.delete(historicalState);
                  await historicalState.close();
                },
              };
            } catch (error) {
              await historicalState.close();
              throw error;
            }
          },
        });
        historicalSupervisors.push(supervisor);
        supervisor.start();
      }
    }

    if (config.modes.includes('epoch-proofs')) {
      // Prover tips and subsidies are paid in the pinned portal's underlying.
      await readPayoutToken(publicClient, new OxidePortalContract(publicClient, currentPublicConfig.portal));
      currentServices.push(
        await startEpochProofs(config, manifest.current, { l1TxUtils, l1SubmissionBatcher, priceOracle }),
      );
    }

    if (config.modes.includes('fpc-funding') && !config.disableSubmission && l1TxUtils && l1SubmissionBatcher) {
      const fpcFunding = FpcFunderCaller.create({
        fpcFunder: currentPublicConfig.fpcFunder,
        executor: currentPublicConfig.operationExecutor,
        l1TxUtils,
        l1SubmissionBatcher,
        priceOracle,
        allowUnprofitable: config.allowUnprofitable,
        pollIntervalMs: config.fpcFundingPollIntervalMs,
      });
      fpcFunding.start();
      currentServices.push(fpcFunding);
    }
    if (config.modes.includes('fpc-funding') && config.disableSubmission) {
      console.log('fpc-funding mode is enabled but submission is disabled; FPC funder caller will not start.');
    }

    await waitForShutdown(opts.shutdownSignal);
  } finally {
    await Promise.allSettled(historicalSupervisors.map(supervisor => supervisor.stop()));
    await Promise.allSettled(currentServices.map(service => service.stop()));
    if (l1SubmissionBatcher) {
      await Promise.allSettled([l1SubmissionBatcher.stop()]);
    }
    // stop() with a timeout so shutdown does not hang if the exporter stalls.
    await Promise.allSettled([
      Promise.race([
        telemetryClient.stop(),
        new Promise<void>(resolve => setTimeout(resolve, TELEMETRY_STOP_MS).unref()),
      ]),
    ]);
    await Promise.allSettled(historicalSupervisors.map(supervisor => supervisor.close()));
    await state?.close();
    sdn?.stop();
  }
}

/** The hostname of an L1 RPC URL, for logs that must not leak the provider API key the URL embeds. */
function rpcHost(url: string): string {
  return new URL(url).hostname;
}

/**
 * Reads the portal underlying, the token that L1-operation and epoch-proof payouts are in. Each profit floor is
 * `weiToUSD`, an 18-decimal USD amount, so the relayer can price only an 18-decimal USD stablecoin.
 */
export async function readPayoutToken(
  client: Pick<ViemPublicClient, 'readContract'>,
  portal: Pick<OxidePortalContract, 'getUnderlying'>,
): Promise<EthAddress> {
  const token = await portal.getUnderlying();
  const decimals = await client.readContract({ address: token.toString(), abi: erc20Abi, functionName: 'decimals' });
  if (decimals !== 18) {
    throw new Error(
      `portal underlying ${token.toString()} has ${decimals} decimals; the relayer prices payouts as 18-decimal USD`,
    );
  }
  return token;
}

/**
 * The l1-operations screen reads the logs of an `eth_simulateV1` run, so a read RPC without the method cannot
 * execute an operation. One trivial simulation at startup fails the process instead of deferring every operation
 * forever. Providers answer an unsupported method in different ways (`-32601`, custom messages, plain-text HTTP
 * bodies), so every error counts as unsupported.
 */
export async function assertSimulateV1Supported(
  client: Pick<ViemPublicClient, 'simulateBlocks'>,
  readL1RpcUrl: string,
): Promise<void> {
  try {
    await client.simulateBlocks({ blocks: [{ calls: [{ to: zeroAddress }] }] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `l1-operations mode needs a read RPC that supports eth_simulateV1; ${rpcHost(readL1RpcUrl)} answered: ${message}`,
    );
  }
}

function waitForShutdown(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise(resolve => {
    const shutdown = (): void => {
      process.off('SIGINT', shutdown);
      process.off('SIGTERM', shutdown);
      signal?.removeEventListener('abort', shutdown);
      resolve();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    signal?.addEventListener('abort', shutdown, { once: true });
  });
}
