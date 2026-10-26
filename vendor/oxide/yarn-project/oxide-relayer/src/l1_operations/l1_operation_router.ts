import type { AztecAddress } from '@aztec-labs/aztec.js/addresses';
import type { Logger } from '@aztec-labs/foundation/log';

import { type BroadcastL1Operation, L1OperationConditionKind } from '@oxide/oxide-lib/l1_operation_calldata.js';
import { addressKey } from '@oxide/watcher-lib/address-key';

import type {
  DeploymentEnvManifestPublicConfig,
  ResolvedManifestDeployment,
} from '../config/deployment_env_manifest.js';
import type { PendingL1Operation, StateStore } from '../state/types.js';

/** What a worker needs: which operations on its Broadcaster are its to handle. */
export interface L1OperationOwnership {
  /** Whether the worker owns an operation that it reads from its Broadcaster. */
  owns(operation: Pick<BroadcastL1Operation, 'target' | 'payoutToken' | 'condition'>): boolean;
  /**
   * Returns the deployment that currently has ownership of a pending operation this worker holds, if any. If undefined,
   * either this worker is the owner, or the owner does not currently hold the operation. Because operation ownership
   * can change over time, a worker should call this before processing an operation to ensure it doesn't conflict with
   * another worker.
   */
  givesWayTo(
    operation: Pick<PendingL1Operation, 'operationId' | 'target' | 'payoutToken' | 'condition'>,
  ): Promise<string | undefined>;
}

/** The parts of a manifest entry that the router reads. The router has one worker for each entry. */
export type RoutedDeployment = Pick<ResolvedManifestDeployment, 'label'> & {
  publicConfig: Pick<DeploymentEnvManifestPublicConfig, 'portal' | 'token' | 'broadcaster'>;
};

/**
 * Gives each L1 operation on a Broadcaster to exactly one worker. Workers of deployments that share a Broadcaster
 * read the same operations, so without this they would all store and execute each one.
 *
 * The worker that handles an operation is:
 * - for a withdrawal finalization (a `MessageInOutbox` condition), the worker of the Portal that the operation
 *   targets, because only that worker can complete it;
 * - for any other operation, the first running worker whose token is the payout token, and else the first running
 *   worker on the Broadcaster.
 */
export class L1OperationRouter {
  /** The deployments of the workers on each Broadcaster, by `broadcaster.toString()`, in the order they were added. */
  private readonly workers = new Map<string, RoutedDeployment[]>();
  /** The store of each running worker, by `addressKey` of its Portal. */
  private readonly stores = new Map<string, Pick<StateStore, 'getPendingL1Operation'>>();

  constructor(private readonly log: Logger) {}

  /** Adds the worker of a deployment before it starts. Adding a deployment that the router already has does nothing. */
  addWorker(deployment: RoutedDeployment): void {
    const key = deployment.publicConfig.broadcaster.toString();
    const workers = this.workers.get(key) ?? [];
    if (workers.some(known => known.publicConfig.portal.equals(deployment.publicConfig.portal))) {
      return;
    }

    workers.push(deployment);
    this.workers.set(key, workers);
    if (workers.length > 1) {
      this.log.info(
        `deployments ${workers.map(known => known.label).join(', ')} share broadcaster ${key}; ` +
          'each of their L1 operations goes to one worker',
      );
    }
  }

  attachStore(deployment: RoutedDeployment, store: Pick<StateStore, 'getPendingL1Operation'>): void {
    this.stores.set(addressKey(deployment.publicConfig.portal), store);
  }

  detachStore(deployment: RoutedDeployment): void {
    this.stores.delete(addressKey(deployment.publicConfig.portal));
  }

  ownershipFor(deployment: RoutedDeployment): L1OperationOwnership {
    const { portal, broadcaster } = deployment.publicConfig;
    return {
      owns: operation => {
        const handler = this.handlerOf(broadcaster, operation);
        return handler !== undefined && handler.publicConfig.portal.equals(portal);
      },
      givesWayTo: async operation => {
        const owner = this.handlerOf(broadcaster, operation);
        if (owner === undefined || owner.publicConfig.portal.equals(portal)) {
          return undefined;
        }
        const store = this.stores.get(addressKey(owner.publicConfig.portal));
        const held = store && (await store.getPendingL1Operation(operation.operationId));
        return held ? owner.label : undefined;
      },
    };
  }

  /** The running worker that handles `operation` on `broadcaster`, or undefined when no running worker can. */
  private handlerOf(
    broadcaster: AztecAddress,
    operation: Pick<BroadcastL1Operation, 'target' | 'payoutToken' | 'condition'>,
  ): RoutedDeployment | undefined {
    const workers = (this.workers.get(broadcaster.toString()) ?? []).filter(({ publicConfig }) =>
      this.stores.has(addressKey(publicConfig.portal)),
    );
    if (operation.condition.kind === L1OperationConditionKind.MessageInOutbox) {
      return workers.find(({ publicConfig }) => addressKey(publicConfig.portal) === addressKey(operation.target));
    }
    return workers.find(({ publicConfig }) => publicConfig.token.equals(operation.payoutToken)) ?? workers[0];
  }
}
