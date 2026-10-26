import {
  ATTRIBUTE_DEFINITIONS,
  HTTP_RESPONSE_STATUS_CODE,
  HTTP_ROUTE,
  L1_OBSERVER_CHECK_NAME,
  L1_OBSERVER_DEPLOYMENT_LABEL,
  L1_OBSERVER_MIGRATION_FLOW,
  L1_OBSERVER_OPERATION_KIND,
  L1_OBSERVER_PORTAL,
  L1_OBSERVER_TOKEN_SYMBOL,
  RELAYER_DEFER_REASON,
  RELAYER_OPERATION_KIND,
  RELAYER_OUTCOME,
  RELAYER_SKIP_REASON,
  RELAYER_STREAM,
  RELAYER_SUBSYSTEM,
  RESOLVER_BROADCAST_OUTCOME,
  RESOLVER_OUTCOME,
  RESOLVER_SIPA_STATE,
  TEE_ROUTER_DISCOVERY_FAILURE_KIND,
  TEE_ROUTER_OUTCOME,
  TEE_ROUTER_UPSTREAM_FAILURE_KIND,
} from './attributes.js';
import { defineMetric, validateRegistry } from './metric_definition.js';

const REQUEST_ATTRIBUTES = [HTTP_ROUTE, HTTP_RESPONSE_STATUS_CODE, TEE_ROUTER_OUTCOME] as const;

export const TEE_ROUTER_REQUEST_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.request.count',
  description: 'Number of requests completed by tee-router.',
  unit: '{request}',
  valueType: 'int',
  requiredAttributes: REQUEST_ATTRIBUTES,
  optionalAttributes: [],
});

export const TEE_ROUTER_REQUEST_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.tee_router.request.duration',
  description: 'End-to-end duration of requests handled by tee-router.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: REQUEST_ATTRIBUTES,
  optionalAttributes: [],
  histogramBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 180, 200],
});

// An observable gauge, not an up-down counter: awsemf renders cumulative sums as per-interval deltas,
// which would turn "current active requests" into "change in active requests". No route attribute —
// only /rpc requests are counted.
export const TEE_ROUTER_REQUEST_ACTIVE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.request.active',
  description: 'Number of tee-router requests currently in progress.',
  unit: '{request}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_TARGET_ROUTABLE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.target.routable',
  description: 'Number of currently routable tee-router targets.',
  unit: '{target}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_DISCOVERY_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.tee_router.discovery.age',
  description: 'Age of the most recent successful target discovery result.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_ROUTER_DISCOVERY_FAILURE = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.discovery.failure',
  description: 'Number of target discovery failures.',
  unit: '{failure}',
  valueType: 'int',
  requiredAttributes: [TEE_ROUTER_DISCOVERY_FAILURE_KIND] as const,
  optionalAttributes: [],
});

export const TEE_ROUTER_UPSTREAM_FAILURE = defineMetric({
  kind: 'counter',
  name: 'oxide.tee_router.upstream.failure',
  description: 'Number of tee-router upstream proxy failures.',
  unit: '{failure}',
  valueType: 'int',
  requiredAttributes: [TEE_ROUTER_UPSTREAM_FAILURE_KIND] as const,
  optionalAttributes: [],
});

// ── TEE registrar ─────────────────────────────────────────────────────────────
// The registrar records these synchronous gauges after each successful fleet scan. When the scans fail, the
// gauges get no datapoints and the missing-data alarms fire.

export const TEE_REGISTRAR_STUCK_JOBS = defineMetric({
  kind: 'gauge',
  name: 'oxide.tee_registrar.stuck_jobs',
  description: 'Number of registration jobs that stay in one phase for longer than its limit.',
  unit: '{job}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_REGISTRAR_EXPIRING_LEASES = defineMetric({
  kind: 'gauge',
  name: 'oxide.tee_registrar.expiring_leases',
  description: 'Number of ready hosts whose last successful probe is older than half the identity lease.',
  unit: '{lease}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const TEE_REGISTRAR_HOSTS_WITHOUT_ROUTABLE_IDENTITY = defineMetric({
  kind: 'gauge',
  name: 'oxide.tee_registrar.hosts_without_routable_identity',
  description: 'Number of in-service hosts that do not have a ready, current, and unexpired identity.',
  unit: '{host}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

// ── Relayer ───────────────────────────────────────────────────────────────────
// The relayer is a long-running service; levels are observable gauges read at each export.

export const RELAYER_L1_OPERATION_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.relayer.l1_operation.count',
  description: 'L1 operation work item checks, by outcome and operation kind.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [RELAYER_OUTCOME, RELAYER_OPERATION_KIND] as const,
  optionalAttributes: [RELAYER_DEFER_REASON] as const,
});

export const RELAYER_L1_OPERATION_SKIPPED = defineMetric({
  kind: 'counter',
  name: 'oxide.relayer.l1_operation.skipped',
  description: 'L1 operations found on L2 that the relayer did not store, by reason and operation kind.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [RELAYER_SKIP_REASON, RELAYER_OPERATION_KIND] as const,
  optionalAttributes: [],
});

export const RELAYER_L1_OPERATION_PENDING = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.l1_operation.pending',
  description: 'L1 operations currently pending, due or backed off.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_L1_OPERATION_WAITING = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.l1_operation.waiting',
  description: 'L1 operations held until their condition fires; never simulated while waiting.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_WATCHER_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.watcher.age',
  description: 'Age of the most recent successful poll of a watched log stream.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [RELAYER_STREAM] as const,
  optionalAttributes: [],
});

// Realized cost from mined receipts (gasUsed * effectiveGasPrice), including reverted txs. Cancellation
// txs are not counted.
export const RELAYER_GAS_SPENT = defineMetric({
  kind: 'counter',
  name: 'oxide.relayer.gas.spent',
  description: 'ETH spent on mined relayer L1 transactions, in whole ETH.',
  unit: '{eth}',
  valueType: 'double',
  requiredAttributes: [RELAYER_SUBSYSTEM] as const,
  optionalAttributes: [],
});

export const RELAYER_ETH_BALANCE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.eth_balance',
  description: 'ETH balance of the relayer signer, in whole ETH. Pays all relayer L1 gas.',
  unit: '{eth}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RELAYER_SDN_LIST_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.relayer.sdn_list.age',
  description:
    'Age of the OFAC SDN list the relayer screens L1 operations against, since its last successful download.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

// ── Resolver ──────────────────────────────────────────────────────────────────
// Two processes share the oxide.resolver.* prefix and split on service.name: the CCIP gateway
// (oxide-resolver-gateway, a Lambda that flushes per invocation) and the singleton deposit watcher
// (oxide-resolver-watcher, a long-running service).

export const RESOLVER_RESOLVE_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.resolve.count',
  description: 'CCIP resolve requests completed by the gateway, by outcome.',
  unit: '{resolve}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_OUTCOME] as const,
  optionalAttributes: [],
});

export const RESOLVER_RESOLVE_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.resolver.resolve.duration',
  description: 'End-to-end duration of CCIP resolve requests.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [RESOLVER_OUTCOME] as const,
  optionalAttributes: [],
  histogramBoundaries: [0.1, 0.25, 0.5, 1, 2, 3, 4, 5, 7.5, 10, 15, 20, 30],
});

// Proof generation dominates resolve latency in profiling (~96% of wall time).
export const RESOLVER_PROOF_DURATION = defineMetric({
  kind: 'histogram',
  name: 'oxide.resolver.proof.duration',
  description: 'Duration of resolution proof generation.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
  histogramBoundaries: [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 20, 30],
});

export const RESOLVER_WATCHER_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.watcher.age',
  description: 'Age of the most recent successful deposit-watcher poll.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SCAN_LAG = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.scan.lag',
  description: 'L1 blocks between the chain tip and the scan cursor at the start of the latest poll.',
  unit: '{block}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SIPA_FUNDED = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.sipa.funded',
  description: 'Resolved SIPAs observed to receive a deposit.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_BROADCAST_COUNT = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.broadcast.count',
  description: 'SIPA broadcast attempts on L2, by outcome.',
  unit: '{broadcast}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_BROADCAST_OUTCOME] as const,
  optionalAttributes: [],
});

export const RESOLVER_RESOLUTIONS = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.resolutions',
  description: 'Resolutions in the store, by lifecycle state. funded = the unbroadcast backlog.',
  unit: '{resolution}',
  valueType: 'int',
  requiredAttributes: [RESOLVER_SIPA_STATE] as const,
  optionalAttributes: [],
});

export const RESOLVER_SIPA_FUNDED_OLDEST_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.sipa.funded_oldest_age',
  description: 'Time since the oldest funded resolution that is not broadcast was funded. 0 when there is none.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SIPA_EXPIRED = defineMetric({
  kind: 'counter',
  name: 'oxide.resolver.sipa.expired',
  description: 'Resolutions pruned because they were never funded inside the watch window.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_FEE_JUICE_BALANCE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.fee_juice_balance',
  description: "Fee-juice balance of the resolver's L2 account, in whole units. Pays SIPA broadcasts.",
  unit: '{fee_juice}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const RESOLVER_SDN_LIST_AGE = defineMetric({
  kind: 'observable-gauge',
  name: 'oxide.resolver.sdn_list.age',
  description: 'Age of the OFAC SDN list the watcher screens SIPA funders against, since its last successful download.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_PORTAL_ESCROW_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal_escrow_balance',
  description: 'Total balance held by known Oxide portals, in underlying token units.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_DEPLOYED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa.deployed',
  description: 'Number of clone deployments through the environment SIPA factory.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_ACCOUNT_DEPLOYED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.account.deployed',
  description: 'Number of account clones deployed through the environment account factory.',
  unit: '{account}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_PORTAL_FROZEN = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.frozen',
  description: 'Number of current Oxide portals that are frozen.',
  unit: '{portal}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.deposit_subsidy.balance',
  description: 'Total token balance available from current deposit subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal_subsidy.balance',
  description: 'Total token balance available from current withdrawal subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_PROVER_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.prover_subsidy.balance',
  description: 'Total token balance available from current prover subsidy contracts.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_FPC_FUNDER_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.fpc_funder.balance',
  description: 'Total input-token balance held by current FPC funders.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_FPC_FUNDER_BOUNTY = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.fpc_funder.bounty',
  description: 'Total caller bounty currently offered by current FPC funders.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_PORTAL_ESCROW_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.portal_escrow_balance',
  description: 'Balance held by the portals of one manifest label, in underlying token units.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_PORTAL_ESCROW_UNEXPLAINED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.escrow_unexplained',
  description:
    'Escrow change of one portal over the finalized blocks of the last scan, less deposits, plus withdrawals, refunds, released tips and FPC funding cuts. Zero when the escrow balances.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_PORTAL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_DEPOSIT_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.deposit_subsidy.balance',
  description: 'Token balance of the deposit subsidy contracts of one manifest label.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_WITHDRAWAL_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.withdrawal_subsidy.balance',
  description: 'Token balance of the withdrawal subsidy contracts of one manifest label.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_PROVER_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.prover_subsidy.balance',
  description: 'Token balance of the prover subsidy contracts of one manifest label.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_FPC_FUNDER_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.fpc_funder.balance',
  description: 'Input-token balance of the FPC funders of one manifest label.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_LABEL_FPC_FUNDER_BOUNTY = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.label.fpc_funder.bounty',
  description: 'Caller bounty that the FPC funders of one manifest label offer.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.deposit.count',
  description: 'Portal deposits observed after the L1 event cursor was initialized.',
  unit: '{deposit}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_DEPOSIT_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.deposit.volume',
  description: 'Net portal deposit volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.withdrawal.count',
  description: 'Portal withdrawals observed after the L1 event cursor was initialized.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.withdrawal.volume',
  description: 'Net portal withdrawal volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_REFUND_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.refund.count',
  description: 'Portal refunds observed after the L1 event cursor was initialized.',
  unit: '{refund}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_REFUND_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.refund.volume',
  description: 'Net portal refund volume observed after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_TIP_RELEASED_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.tip_released.count',
  description: 'Portal tip releases observed after the L1 event cursor was initialized.',
  unit: '{release}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_TIP_RELEASED_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.portal.tip_released.volume',
  description: 'Portal tip volume released after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_REGISTRATION_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.registration.count',
  description: 'Registrations observed after the L1 event cursor was initialized.',
  unit: '{registration}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_REGISTRATION_FEES = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.registration.fees',
  description: 'Registration fees applied after the L1 event cursor was initialized.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L2_PROVEN_TIP_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l2.proven_tip_age',
  description: 'Age of the proven L2 tip of the rollup a manifest entry is bound to, from its block timestamp.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L2_PROVEN_TIP_OVERDUE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l2.proven_tip_overdue',
  description:
    'Part of the proven L2 tip age beyond the proof submission window of the rollup a manifest entry is bound to. Zero while the rollup proves on time.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L2_FINALIZED_TIP_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l2.finalized_tip_age',
  description: 'Age of the finalized L2 tip of the rollup a manifest entry is bound to, from its block timestamp.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L2_PROVEN_TIP_BLOCK = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l2.proven_tip_block',
  description: 'Block number of the proven L2 tip of the rollup a manifest entry is bound to.',
  unit: '{block}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_UNCLAIMED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.unclaimed',
  description:
    'Number of withdrawals of a manifest entry whose initiation is proven on L2 and that are not claimed on L1 after the stuck threshold.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_UNCLAIMED_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.unclaimed_oldest_age',
  description: 'Age of the oldest unclaimed withdrawal of a manifest entry, from its initiation block timestamp.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_UNMATCHED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.unmatched',
  description:
    'Number of withdrawals that the portals of one manifest label paid in the finalized blocks of the last scan, with no L2 burn in the withdrawal lookback.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_UNPROVEN = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.unproven',
  description: 'Number of withdrawals of a manifest entry whose initiation is above the proven L2 tip.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_UNPROVEN_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.unproven_oldest_age',
  description: 'Age of the oldest unproven withdrawal of a manifest entry, from its initiation block timestamp.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_CLAIMABLE_UNCLAIMED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.claimable_unclaimed',
  description:
    'Number of proven withdrawals of a manifest entry that are not claimed on L1 after the stuck threshold from their proof.',
  unit: '{withdrawal}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_WITHDRAWAL_CLAIMABLE_UNCLAIMED_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.withdrawal.claimable_unclaimed_oldest_age',
  description:
    'Age of the oldest claimable unclaimed withdrawal of a manifest entry, from the L1 proof of its checkpoint.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_SWEEP_OPEN = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa_sweep.open',
  description: 'Number of SIPAs of a manifest entry with a broadcast sweep that still hold a balance.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_SWEEP_UNSWEPT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa_sweep.unswept',
  description:
    'Number of SIPAs of a manifest entry that still hold a balance after the stuck threshold from their sweep broadcast.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_SWEEP_DUST = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa_sweep.dust',
  description:
    'Number of SIPAs of a manifest entry with a broadcast sweep whose balance is at or below the deposit fee, so no sweep can execute.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_SWEEP_STRANDED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa_sweep.stranded',
  description:
    'Number of SIPAs of a manifest entry that hold a balance above the deposit fee but are swept and not resweepable, so only a recovery can move the balance.',
  unit: '{sipa}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SIPA_SWEEP_UNSWEPT_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.sipa_sweep.unswept_oldest_age',
  description: 'Age of the oldest unswept SIPA of a manifest entry, from the block timestamp of its sweep broadcast.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SWAP_ESCROW_UNEXECUTED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.swap_escrow.unexecuted',
  description:
    'Number of swap and bridge escrows of a manifest entry that are funded, would run, have a relayer tip that covers the gas, and are not executed after the stuck threshold.',
  unit: '{escrow}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SWAP_ESCROW_UNEXECUTED_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.swap_escrow.unexecuted_oldest_age',
  description: 'Age of the oldest unexecuted swap or bridge escrow of a manifest entry, from when it was first funded.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SWAP_ESCROW_CAPPED = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.swap_escrow.capped',
  description:
    'Number of tracked swap and bridge escrow rows of a manifest entry that the observer dropped in the last run because the entry has more rows than the cap.',
  unit: '{escrow}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_SWAP_ESCROW_FACTORIES = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.swap_escrow.factories',
  description:
    'Number of swap and bridge escrow factories that the deployment manifest lists for a manifest entry. Zero means that the escrow check tracks no escrows for the entry.',
  unit: '{factory}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_REFUND_PENDING = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.refund_pending',
  description:
    'Number of refund operations on the portal of a manifest entry, or through its migration subsidy, that are broadcast, have no spent nullifier, and whose last simulation runs or reverts on an unregistered TEE or a cap.',
  unit: '{operation}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_REFUND_PENDING_OLDEST_AGE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.refund_pending_oldest_age',
  description:
    'Age of the oldest pending refund operation of a manifest entry, from the block timestamp of its broadcast. Zero when no refund is pending.',
  unit: 's',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_COUNT = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.count',
  description:
    'Number of Migrated events of the migration executors whose destination is a manifest entry, by exit flow of the old portal, from the deploy block of the entry.',
  unit: '{migration}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_MIGRATION_FLOW] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.volume',
  description:
    'Amount that the migration executors of a manifest entry deposited into its portal, by exit flow of the old portal, from the deploy block of the entry. The relayer tip is not included.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_MIGRATION_FLOW] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_TIP_VOLUME = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.tip_volume',
  description:
    'Relayer tips that the migration executors of a manifest entry paid from the migrated amount, from the deploy block of the entry.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_MIGRATION_SUBSIDY_BALANCE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.migration.subsidy_balance',
  description: 'Payout token balance of the migration subsidies whose destination is a manifest entry.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_TOKEN_SYMBOL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L1_BASE_FEE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l1.base_fee_gwei',
  description: 'Base fee per gas of the latest L1 block.',
  unit: '{gwei}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_L1_PRIORITY_FEE = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l1.priority_fee_gwei',
  description: 'Max priority fee per gas that the L1 RPC estimates.',
  unit: '{gwei}',
  valueType: 'double',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const L1_OBSERVER_RELAYER_BREAK_EVEN = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.relayer.break_even_gwei',
  description: 'Highest L1 base fee at which the sweep tip and the subsidy of a SIPA intent pay the relayer gas.',
  unit: '{gwei}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_OPERATION_KIND] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_RELAYER_MIN_TIP = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.relayer.min_tip',
  description:
    'Lowest relayer tip at which the tip and the subsidy of a withdrawal flow pay the relayer gas at the current L1 base fee.',
  unit: '{token}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL, L1_OBSERVER_TOKEN_SYMBOL, L1_OBSERVER_OPERATION_KIND] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_L2_MIN_FEE_PER_MANA = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.l2.min_fee_per_mana',
  description:
    'Highest current or predicted min fee per mana of the rollup of a manifest entry, in fee juice base units.',
  unit: '{fee_juice_base_unit}',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_CLAIM_FPC_FEE_HEADROOM = defineMetric({
  kind: 'gauge',
  name: 'oxide.l1_observer.claim_fpc.fee_headroom',
  description:
    'ClaimFPC max fee per gas divided by the padded highest L2 or DA min fee of the rollup of a manifest entry.',
  unit: '1',
  valueType: 'double',
  requiredAttributes: [L1_OBSERVER_DEPLOYMENT_LABEL] as const,
  optionalAttributes: [],
});

export const L1_OBSERVER_CHECK_FAILED = defineMetric({
  kind: 'counter',
  name: 'oxide.l1_observer.check.failed',
  description: 'Number of L1 observer runs in which a check failed for at least one label or did not finish.',
  unit: '{failure}',
  valueType: 'int',
  requiredAttributes: [L1_OBSERVER_CHECK_NAME] as const,
  optionalAttributes: [],
});

export const TELEMETRY_E2E_VERIFICATION = defineMetric({
  kind: 'gauge',
  name: 'oxide.telemetry.e2e_verification',
  description: 'Datapoints sent to verify the metrics pipeline end to end.',
  unit: '{datapoint}',
  valueType: 'int',
  requiredAttributes: [],
  optionalAttributes: [],
});

export const METRIC_DEFINITIONS = [
  TEE_ROUTER_REQUEST_COUNT,
  TEE_ROUTER_REQUEST_DURATION,
  TEE_ROUTER_REQUEST_ACTIVE,
  TEE_ROUTER_TARGET_ROUTABLE,
  TEE_ROUTER_DISCOVERY_AGE,
  TEE_ROUTER_DISCOVERY_FAILURE,
  TEE_ROUTER_UPSTREAM_FAILURE,
  TEE_REGISTRAR_STUCK_JOBS,
  TEE_REGISTRAR_EXPIRING_LEASES,
  TEE_REGISTRAR_HOSTS_WITHOUT_ROUTABLE_IDENTITY,
  RELAYER_L1_OPERATION_COUNT,
  RELAYER_L1_OPERATION_SKIPPED,
  RELAYER_L1_OPERATION_PENDING,
  RELAYER_L1_OPERATION_WAITING,
  RELAYER_WATCHER_AGE,
  RELAYER_GAS_SPENT,
  RELAYER_ETH_BALANCE,
  RELAYER_SDN_LIST_AGE,
  RESOLVER_RESOLVE_COUNT,
  RESOLVER_RESOLVE_DURATION,
  RESOLVER_PROOF_DURATION,
  RESOLVER_WATCHER_AGE,
  RESOLVER_SCAN_LAG,
  RESOLVER_SIPA_FUNDED,
  RESOLVER_BROADCAST_COUNT,
  RESOLVER_RESOLUTIONS,
  RESOLVER_SIPA_FUNDED_OLDEST_AGE,
  RESOLVER_SIPA_EXPIRED,
  RESOLVER_FEE_JUICE_BALANCE,
  RESOLVER_SDN_LIST_AGE,
  L1_OBSERVER_PORTAL_ESCROW_BALANCE,
  L1_OBSERVER_SIPA_DEPLOYED,
  L1_OBSERVER_ACCOUNT_DEPLOYED,
  L1_OBSERVER_PORTAL_FROZEN,
  L1_OBSERVER_DEPOSIT_SUBSIDY_BALANCE,
  L1_OBSERVER_WITHDRAWAL_SUBSIDY_BALANCE,
  L1_OBSERVER_PROVER_SUBSIDY_BALANCE,
  L1_OBSERVER_FPC_FUNDER_BALANCE,
  L1_OBSERVER_FPC_FUNDER_BOUNTY,
  L1_OBSERVER_LABEL_PORTAL_ESCROW_BALANCE,
  L1_OBSERVER_PORTAL_ESCROW_UNEXPLAINED,
  L1_OBSERVER_LABEL_DEPOSIT_SUBSIDY_BALANCE,
  L1_OBSERVER_LABEL_WITHDRAWAL_SUBSIDY_BALANCE,
  L1_OBSERVER_LABEL_PROVER_SUBSIDY_BALANCE,
  L1_OBSERVER_LABEL_FPC_FUNDER_BALANCE,
  L1_OBSERVER_LABEL_FPC_FUNDER_BOUNTY,
  L1_OBSERVER_DEPOSIT_COUNT,
  L1_OBSERVER_DEPOSIT_VOLUME,
  L1_OBSERVER_WITHDRAWAL_COUNT,
  L1_OBSERVER_WITHDRAWAL_VOLUME,
  L1_OBSERVER_REFUND_COUNT,
  L1_OBSERVER_REFUND_VOLUME,
  L1_OBSERVER_TIP_RELEASED_COUNT,
  L1_OBSERVER_TIP_RELEASED_VOLUME,
  L1_OBSERVER_REGISTRATION_COUNT,
  L1_OBSERVER_REGISTRATION_FEES,
  L1_OBSERVER_L2_PROVEN_TIP_AGE,
  L1_OBSERVER_L2_PROVEN_TIP_OVERDUE,
  L1_OBSERVER_L2_FINALIZED_TIP_AGE,
  L1_OBSERVER_L2_PROVEN_TIP_BLOCK,
  L1_OBSERVER_WITHDRAWAL_UNCLAIMED,
  L1_OBSERVER_WITHDRAWAL_UNCLAIMED_OLDEST_AGE,
  L1_OBSERVER_WITHDRAWAL_UNMATCHED,
  L1_OBSERVER_WITHDRAWAL_UNPROVEN,
  L1_OBSERVER_WITHDRAWAL_UNPROVEN_OLDEST_AGE,
  L1_OBSERVER_WITHDRAWAL_CLAIMABLE_UNCLAIMED,
  L1_OBSERVER_WITHDRAWAL_CLAIMABLE_UNCLAIMED_OLDEST_AGE,
  L1_OBSERVER_SIPA_SWEEP_OPEN,
  L1_OBSERVER_SIPA_SWEEP_UNSWEPT,
  L1_OBSERVER_SIPA_SWEEP_DUST,
  L1_OBSERVER_SIPA_SWEEP_STRANDED,
  L1_OBSERVER_SIPA_SWEEP_UNSWEPT_OLDEST_AGE,
  L1_OBSERVER_SWAP_ESCROW_UNEXECUTED,
  L1_OBSERVER_SWAP_ESCROW_UNEXECUTED_OLDEST_AGE,
  L1_OBSERVER_SWAP_ESCROW_CAPPED,
  L1_OBSERVER_SWAP_ESCROW_FACTORIES,
  L1_OBSERVER_MIGRATION_REFUND_PENDING,
  L1_OBSERVER_MIGRATION_REFUND_PENDING_OLDEST_AGE,
  L1_OBSERVER_MIGRATION_COUNT,
  L1_OBSERVER_MIGRATION_VOLUME,
  L1_OBSERVER_MIGRATION_TIP_VOLUME,
  L1_OBSERVER_MIGRATION_SUBSIDY_BALANCE,
  L1_OBSERVER_L1_BASE_FEE,
  L1_OBSERVER_L1_PRIORITY_FEE,
  L1_OBSERVER_RELAYER_BREAK_EVEN,
  L1_OBSERVER_RELAYER_MIN_TIP,
  L1_OBSERVER_L2_MIN_FEE_PER_MANA,
  L1_OBSERVER_CLAIM_FPC_FEE_HEADROOM,
  L1_OBSERVER_CHECK_FAILED,
  TELEMETRY_E2E_VERIFICATION,
] as const;

validateRegistry(ATTRIBUTE_DEFINITIONS, METRIC_DEFINITIONS);
