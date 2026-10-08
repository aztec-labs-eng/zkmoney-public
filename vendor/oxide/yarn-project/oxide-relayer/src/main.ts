import type { EthAddress } from '@aztec/foundation/eth-address';
import { createLogger } from '@aztec/foundation/log';

import { OxidePortalContract, depositTokensFor } from '@oxide/l1-contracts';
import { FleetSigner } from '@oxide/oxide-client/fleet_signer.js';
import { createNodeClient } from '@oxide/oxide-lib/aztec_node_client.js';
import { L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';
import type { TeeSigner } from '@oxide/oxide-lib/types.js';
import { initTelemetry } from '@oxide/telemetry';
import { OFAC_SDN_LIST_URL, OfacSdnList } from '@oxide/watcher-lib/sanctions';

import { type PublicClient, erc20Abi, zeroAddress } from 'viem';

import { type RunConfig, redactRunConfig } from './cli/config.js';
import {
  type DeploymentEnvManifestPublicConfig,
  type ResolvedManifestDeployment,
  resolveDeploymentEnvManifest,
} from './config/deployment_env_manifest.js';
import { DeploymentManifestRefresher } from './config/deployment_manifest_refresher.js';
import { FpcFunderCaller } from './fpc_funding/fpc_funder_caller.js';
import { HistoricalDeploymentSupervisor } from './historical_deployment_supervisor.js';
import { getL1PublicClient } from './l1/client.js';
import { assertNotFlashbots } from './l1/flashbots_protect.js';
import { createL1TxQueue } from './l1/l1_tx_queue.js';
import { L1OperationRelayer } from './l1_operations/l1_operation_relayer.js';
import { WithdrawalCompletion } from './l1_operations/withdrawal_completion.js';
import { ChainlinkPriceOracle } from './price_oracle/chainlink_price_oracle.js';
import { startEpochProofs } from './prover/index.js';
import { RelayerTelemetry } from './relayer_telemetry.js';
import { createEphemeralSigner, hasSignerKey, loadSigner } from './signers/index.js';
import { statePathForPortal } from './state/path.js';
import { type SqliteStateStore, openSqliteStateStore } from './state/sqlite_store.js';
import { relayerVersion } from './version.js';

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
  const log = createLogger('oxide-relayer');
  log.info(`oxide-relayer version ${relayerVersion()}`);
  log.info('Starting relayer', { config: redactRunConfig(config) });

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

  const signer =
    config.disableSubmission && !hasSignerKey(config.signer)
      ? createEphemeralSigner()
      : await loadSigner(config.signer);
  const l1TxQueue = createL1TxQueue({
    client: publicClient,
    account: signer.account,
    readL1RpcUrl: config.readL1RpcUrl,
    flashbotsBlockRange: config.flashbotsBlockRange,
    disableSubmission: config.disableSubmission,
    maxFeePerGasCap:
      config.l1MaxFeePerGasGwei === undefined ? undefined : BigInt(Math.trunc(config.l1MaxFeePerGasGwei * 1e9)),
  });

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
  let manifestRefresher: DeploymentManifestRefresher | undefined;
  const operationStores = new Set<SqliteStateStore>();
  const currentServices: Array<{ stop(): Promise<void> }> = [];
  try {
    state = await openSqliteStateStore(currentStatePath, identity(manifest.current));
    const priceOracle = new ChainlinkPriceOracle(publicClient, { chainId });
    console.log(
      [
        `oxide-relayer starting label=${manifest.current.label}`,
        `modes=${config.modes.join(',')}`,
        // Hostnames only: the read RPC URL embeds a provider API key.
        `l1ReadRpc=${rpcHost(config.readL1RpcUrl)}`,
        `portal=${currentPublicConfig.portal}`,
        `rollupVersion=${currentPublicConfig.rollupVersion}`,
        `aztecNodeUrl=${config.aztecNodeUrl}`,
        `aztecNodeApiKey=${config.aztecNodeApiKey ? '(configured)' : '(none)'}`,
        `enclaveUrl=${currentPublicConfig.enclaveUrl || '(none)'}`,
        `state=${currentStatePath}`,
        `signer=${signer.backend}:${signer.address}`,
        `submission=${config.disableSubmission ? 'disabled' : 'enabled'}`,
        `l1MaxFeePerGasGwei=${config.l1MaxFeePerGasGwei ?? '(none)'}`,
        `priceFeed=${priceOracle.feed.toString()}`,
        `sdn=${config.modes.includes('l1-operations') ? rpcHost(config.sdnUrl ?? OFAC_SDN_LIST_URL) : '(none)'}`,
        `l1OperationScreening=${config.modes.includes('l1-operations') ? 'enabled' : 'disabled'}`,
      ].join(' '),
    );

    if (config.disableSubmission) {
      console.log('submission is disabled; relayer will skip L1 transaction sends and treat them as mined.');
    }

    // The ephemeral key holds no ETH, so its balance tells nothing.
    if (signer.backend !== 'ephemeral') {
      telemetry.observeSignerBalance(() => publicClient.getBalance({ address: signer.address }));
    }
    if (config.modes.includes('l1-operations')) {
      const { l1OperationsSubmission } = config;
      if (!l1OperationsSubmission) {
        throw new Error('l1-operations mode requires the L1 operation submission policy');
      }
      const sanctionsList = await OfacSdnList.start(config.sdnUrl);
      sdn = sanctionsList;
      telemetry.observeSdnListAge(() => sanctionsList.lastRefreshedAt);
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
      await assertSimulateV1Supported(publicClient, config.readL1RpcUrl);
      const start = async (deployment: ResolvedManifestDeployment, store: SqliteStateStore) => {
        const { publicConfig, label } = deployment;
        const portal = new OxidePortalContract(publicClient, publicConfig.portal);
        const payoutTokens = await selectPayoutTokens(publicClient, config.l1OperationsPayoutTokens, publicConfig);
        if (!opts.teeSigner && !publicConfig.enclaveUrl) {
          throw new Error(`no enclave is published for deployment ${label}:${publicConfig.portal}`);
        }
        const withdrawalSigner = opts.teeSigner ?? (await FleetSigner.connect(publicConfig.enclaveUrl, portal));
        const worker = L1OperationRelayer.create({
          node,
          publicClient,
          store,
          broadcaster: publicConfig.broadcaster,
          payoutTokens,
          watchedTokens: depositTokensFor(chainId, publicConfig.token),
          l1OperationsSubmission,
          allowUnprofitable: config.allowUnprofitable,
          executor: publicConfig.operationExecutor,
          l1TxQueue,
          sanctionsList,
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
      const discover = (deployment: ResolvedManifestDeployment, path: string) => {
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
      };
      for (const { deployment, path } of historicalPaths) {
        discover(deployment, path);
      }
      manifestRefresher = new DeploymentManifestRefresher({
        deploymentEnvManifestUrl: config.deploymentEnvManifestUrl,
        initial: manifest,
        discover: deployment =>
          discover(deployment, statePathForPortal(config.state.sqlitePath, deployment.publicConfig.portal, 2)),
      });
    }

    if (config.modes.includes('epoch-proofs')) {
      // Prover tips and subsidies are paid in the pinned portal's underlying.
      await readUnderlyingToken(publicClient, new OxidePortalContract(publicClient, currentPublicConfig.portal));
      currentServices.push(
        await startEpochProofs(config, manifest.current, {
          client: publicClient,
          l1TxQueue,
          priceOracle,
          teeSigner: opts.teeSigner,
        }),
      );
    }

    if (config.modes.includes('fpc-funding')) {
      const fpcFunding = FpcFunderCaller.create({
        fpcFunder: currentPublicConfig.fpcFunder,
        executor: currentPublicConfig.operationExecutor,
        client: publicClient,
        l1TxQueue,
        priceOracle,
        allowUnprofitable: config.allowUnprofitable,
        pollIntervalMs: config.fpcFundingPollIntervalMs,
      });
      fpcFunding.start();
      currentServices.push(fpcFunding);
    }

    manifestRefresher?.start();
    await waitForShutdown(opts.shutdownSignal);
  } finally {
    await manifestRefresher?.stop();
    await Promise.allSettled(historicalSupervisors.map(supervisor => supervisor.stop()));
    await Promise.allSettled(currentServices.map(service => service.stop()));
    await Promise.allSettled([l1TxQueue.stop()]);
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
 * The tokens an L1-operations worker accepts as payout: the configured list, or else the token of the manifest entry.
 */
export async function selectPayoutTokens(
  client: Pick<PublicClient, 'readContract'>,
  configured: EthAddress[] | undefined,
  deployment: Pick<DeploymentEnvManifestPublicConfig, 'token'>,
): Promise<EthAddress[]> {
  const tokens = configured ?? [deployment.token];
  await Promise.all(tokens.map(token => assertPriceable(client, token, 'payout token')));
  return tokens;
}

/** Reads the portal underlying, the token prover tips and the prover subsidy are paid in. */
export async function readUnderlyingToken(
  client: Pick<PublicClient, 'readContract'>,
  portal: Pick<OxidePortalContract, 'getUnderlying'>,
): Promise<EthAddress> {
  return assertPriceable(client, await portal.getUnderlying(), 'portal underlying');
}

/**
 * Each profit floor is `weiToUSD`, an 18-decimal USD amount, so the relayer can price only an 18-decimal USD
 * stablecoin.
 */
async function assertPriceable(
  client: Pick<PublicClient, 'readContract'>,
  token: EthAddress,
  what: string,
): Promise<EthAddress> {
  const decimals = await client.readContract({ address: token.toString(), abi: erc20Abi, functionName: 'decimals' });
  if (decimals !== 18) {
    throw new Error(
      `${what} ${token.toString()} has ${decimals} decimals; the relayer prices payouts as 18-decimal USD`,
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
  client: Pick<PublicClient, 'simulateBlocks'>,
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
