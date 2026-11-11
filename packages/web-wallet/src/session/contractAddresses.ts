import { PER_INSTANCE_CONTRACTS } from "@obsidion/config-client"
import { DEFAULT_CONTRACTS_NAME } from "@obsidion/core/constants"
import type { ContractName, OxideEnvTuple } from "@obsidion/core/types"
import type { Query, QueryFactory, Service } from "@obsidion/front-core"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"

type Chain = "L1" | "L2"

export type Row = { label: string; chain: Chain; value?: string }

type Group = { title: string; rows: Row[] }

const FLEET_CONTRACTS = DEFAULT_CONTRACTS_NAME.filter(
  (name) => !(PER_INSTANCE_CONTRACTS as readonly ContractName[]).includes(name),
)

type TupleNonAddress =
  | "version"
  | "gitSha"
  | "timestamp"
  | "deployedAt"
  | "deployedAtBlock"
  | "chainId"
  | "enclaveUrl"
  | "pcr0"
  | "rollupVersion"
  | "ensDomain"
  | "resolverGatewayUrl"
  | "frozenNotesRefundVkSha256"
  | "frozenDepositRefundVkSha256"
  | "fpcBeneficiarySalt"
  | "sipaRecoveryProtocol"
  | "bridgeKey"
  | "bridgeId"
  | "features"
  | "l2TokenImmutables"
  | "priorSipaGenerations"

const OXIDE_CHAIN = {
  portal: "L1",
  token: "L1",
  underlying: "L1",
  l2Token: "L2",
  registry: "L1",
  accountMetadataRegistry: "L1",
  registrationController: "L1",
  namePortal: "L1",
  accountFactory: "L1",
  entryPoint: "L1",
  paymaster: "L1",
  sipaFactory: "L1",
  sipaResolver: "L1",
  resolverProofVerifier: "L1",
  depositSIPAImplementation: "L1",
  registrationSIPAImplementation: "L1",
  forwardingTable: "L1",
  feeToken: "L1",
  depositSubsidy: "L1",
  withdrawalSubsidy: "L1",
  proverSubsidy: "L1",
  plainWithdrawalExecutor: "L1",
  swapEscrowFactoryV2: "L1",
  skyEscrowFactory: "L1",
  acrossBridgeEscrowFactory: "L1",
  cctpBridgeEscrowFactory: "L1",
  operationExecutor: "L1",
  certManager: "L1",
  nitroValidator: "L1",
  frozenNotesRefundVerifier: "L1",
  frozenDepositRefundVerifier: "L1",
  unprocessedDepositRefundVerifier: "L1",
  l2Broadcaster: "L2",
  fpcFunder: "L1",
  fpcBeneficiary: "L2",
} satisfies Record<Exclude<keyof OxideEnvTuple, TupleNonAddress>, Chain>

const NODE_L1 = {
  rollup: "rollupAddress",
  registry: "registryAddress",
  inbox: "inboxAddress",
  outbox: "outboxAddress",
  feeJuice: "feeJuiceAddress",
  feeJuicePortal: "feeJuicePortalAddress",
} as const

const text = (value: unknown): string | undefined => {
  const s = value == null ? "" : String(value)
  return s.trim() ? s : undefined
}

interface ContractAddressServices {
  contractService: Service<ContractService>
  wallet: Service<Pick<ObsidionWallet, "node">>
}

/**
 * The deployment contracts the wallet points at: the profile L2 set, the oxide manifest tuple and,
 * keyed `true`, the Aztec protocol's as the wallet's node names them. A failed read fails the load,
 * so a row is missing only when the deployment names no address for it.
 */
export const contractAddresses = (
  query: QueryFactory,
  services: ContractAddressServices,
): Query<[boolean], Group[]> =>
  query<[boolean], Group[]>("contractAddresses", {
    load: (withNode, signal) => addressGroups(services, withNode, signal),
  })

async function addressGroups(
  services: ContractAddressServices,
  withNode: boolean,
  signal: AbortSignal,
): Promise<Group[]> {
  const contractService = await services.contractService.ready(signal)
  const node = withNode ? (await services.wallet.ready(signal)).node : undefined
  const client = contractService.getOxideClient()
  await client?.initialize()
  const tuple = client?.getCurrentTuple() ?? null
  const l2 = await Promise.all(
    FLEET_CONTRACTS.map((name) => contractService.getContractAddress(name)),
  )
  const info = node ? await node.getNodeInfo() : undefined
  const l2Rows = FLEET_CONTRACTS.map(
    (label, i): Row => ({ label, chain: "L2", value: text(l2[i]?.toString()) }),
  )
  const oxideRows = Object.entries(OXIDE_CHAIN).map(
    ([field, chain]): Row => ({
      label: field,
      chain,
      value: text(tuple?.[field as keyof typeof OXIDE_CHAIN]),
    }),
  )
  const featureRows = (tuple?.features ?? []).flatMap((feature) =>
    Object.entries(feature.contracts).map(
      ([name, address]): Row => ({
        label: `${feature.id} ${name}`,
        chain: "L1",
        value: text(address),
      }),
    ),
  )
  const nodeRows: Row[] = [
    ...Object.entries(NODE_L1).map(
      ([label, key]): Row => ({
        label,
        chain: "L1",
        value: text(info?.l1ContractAddresses[key]?.toString()),
      }),
    ),
    {
      label: "feeJuice (L2)",
      chain: "L2",
      value: text(info?.protocolContractAddresses.feeJuice?.toString()),
    },
  ]
  return [
    { title: "zk.money contracts", rows: l2Rows },
    { title: "Oxide deployment", rows: [...oxideRows, ...featureRows] },
    { title: "Aztec protocol", rows: nodeRows },
  ]
}
