import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  L1SwapEscrowReader,
  L1WithdrawalFinalizationReader,
  readExecutorPortal,
  readExecutorSubsidy,
  readWithdrawalExecutor,
  SwapOnWithdrawSimulator,
  type WithdrawalExecutor,
  type WithdrawalExecutorKind,
} from "@obsidion/sdk"
import {
  keyedService,
  findBlockAtTime,
  resolveWithdrawalWiring,
  type QueryFactory,
  type TrackerRails,
} from "@obsidion/front-core"
import type { Address, Hex, PublicClient } from "viem"
import { requireTupleField } from "../../config/oxideTuple"

/**
 * The tracker's L1 readers over `tuple`, and the page's bridge-out providers; null when the tuple
 * lacks the oxide-rails coordinates, where withdrawals are unavailable.
 */
export function trackerRails(
  client: PublicClient,
  tuple: OxideEnvTuple,
  bridgeOut: TrackerRails["bridgeOut"],
): TrackerRails | null {
  const wiring = resolveWithdrawalWiring(tuple)
  const publicClient = client as unknown as ConstructorParameters<
    typeof L1WithdrawalFinalizationReader
  >[0]
  const readerFor = (d: { portal: Hex }) =>
    new L1WithdrawalFinalizationReader(publicClient, { portal: d.portal })
  return (
    wiring && {
      finalizationReader: readerFor(wiring),
      deployment: { portal: wiring.portal, l2Token: wiring.l2Token },
      // A burn on a since-retired deployment finalizes on ITS portal, not the live one.
      readerForDeployment: readerFor,
      // The swap leg watches the escrow itself; the factory comes off each record.
      swapEscrowReader: new L1SwapEscrowReader(publicClient, {
        dai: requireTupleField(tuple, "token") as Address,
      }),
      bridgeOut,
      l1BlockAt: async (ms) =>
        findBlockAtTime(publicClient, Math.floor(ms / 1000), await publicClient.getBlockNumber()),
    }
  )
}

/** The page's reads of executor and escrow-factory immutables, each read once. */
export function withdrawalReads(client: () => PublicClient, query: QueryFactory) {
  const executors = query<[Address, WithdrawalExecutorKind], WithdrawalExecutor>(
    "withdrawalExecutor",
    { load: (address, kind) => readWithdrawalExecutor(client(), address, kind) },
  )
  return {
    // Each keeps the deployment reads (escrow implementation, feed, balance slot) across simulations.
    swapSimulator: keyedService(
      "swapSimulator",
      {
        retry: "manual",
        key: (tuple: OxideEnvTuple) => [
          tuple.swapEscrowFactoryV2,
          tuple.operationExecutor,
          tuple.token,
        ],
      },
      async ([tuple]) =>
        new SwapOnWithdrawSimulator(client(), {
          swapEscrowFactoryV2: requireTupleField(tuple, "swapEscrowFactoryV2") as Address,
          operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
          token: requireTupleField(tuple, "token") as Address,
        }),
    ),
    withdrawalExecutorAt: (address: Address, kind: WithdrawalExecutorKind = "plain") =>
      executors(address, kind),
    executorPortalAt: query<[Address], Address>("executorPortal", {
      load: (address) => readExecutorPortal(client(), address),
    }),
    executorSubsidyAt: query<[Address], Address>("executorSubsidy", {
      load: (address) => readExecutorSubsidy(client(), address),
    }),
  }
}
