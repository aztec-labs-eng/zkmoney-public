import { type Logger, createLogger } from '@aztec/foundation/log';
import { RunningPromise } from '@aztec/foundation/running-promise';

import {
  type ResolvedDeploymentEnvManifest,
  type ResolvedManifestDeployment,
  resolveDeploymentEnvManifest,
} from './deployment_env_manifest.js';

export const MANIFEST_REFRESH_INTERVAL_MS = 5 * 60_000;
const MANIFEST_FETCH_TIMEOUT_MS = 10_000;

interface DeploymentManifestRefresherOptions {
  deploymentEnvManifestUrl: string;
  initial: ResolvedDeploymentEnvManifest;
  discover: (deployment: ResolvedManifestDeployment) => void;
  fetch?: typeof fetch;
  logger?: Logger;
}

/** Add operation workers on the startup rollup without changing the pinned deployment. */
export class DeploymentManifestRefresher {
  private readonly seen: Set<string>;
  private readonly abortController = new AbortController();
  private readonly runningPromise: RunningPromise;
  private readonly log: Logger;

  constructor(private readonly options: DeploymentManifestRefresherOptions) {
    this.seen = new Set(
      [options.initial.current, ...options.initial.historical].map(d => d.publicConfig.portal.toString().toLowerCase()),
    );
    this.log = options.logger ?? createLogger('oxide-relayer:manifest');
    this.runningPromise = new RunningPromise(() => this.runOnce(), this.log, MANIFEST_REFRESH_INTERVAL_MS);
  }

  start(): void {
    this.runningPromise.start();
  }

  async stop(): Promise<void> {
    this.abortController.abort();
    await this.runningPromise.stop();
  }

  async runOnce(): Promise<void> {
    if (this.abortController.signal.aborted) {
      return;
    }
    try {
      const manifest = await resolveDeploymentEnvManifest({
        deploymentEnvManifestUrl: this.options.deploymentEnvManifestUrl,
        portal: this.options.initial.current.publicConfig.portal,
        fetch: (input, init) =>
          (this.options.fetch ?? fetch)(input, {
            ...init,
            signal: AbortSignal.any([this.abortController.signal, AbortSignal.timeout(MANIFEST_FETCH_TIMEOUT_MS)]),
          }),
      });
      if (this.abortController.signal.aborted) {
        return;
      }
      if (manifest.current.publicConfig.rollupVersion !== this.options.initial.current.publicConfig.rollupVersion) {
        throw new Error('The startup deployment rollup version changed in the manifest.');
      }
      for (const reason of manifest.unreadable) {
        this.log.warn(`Not watching a deployment: ${reason}`);
      }
      for (const deployment of manifest.historical) {
        const portal = deployment.publicConfig.portal.toString().toLowerCase();
        if (!this.seen.has(portal)) {
          this.options.discover(deployment);
          this.seen.add(portal);
        }
      }
    } catch (error) {
      if (!this.abortController.signal.aborted) {
        this.log.warn(`Manifest refresh failed; existing workers continue: ${String(error)}`);
      }
    }
  }
}
