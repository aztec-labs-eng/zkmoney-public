import type { OxideEnvTuple, SourceSavingsMove } from "@obsidion/core/types"
import {
  deploymentScanRange,
  savingsRoute,
  refundableSavingsDeposits,
  type FieldLike,
} from "@obsidion/front-core"
import { createWithdrawEventSource, readWithdrawalExecutor } from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import { portalContract } from "../token/oxideToken"
import type { SourceChain } from "./historicTokenContext"

/** Recover the deposits of Savings moves between the retired rollup's tokens. */
export async function sourceSavingsDeposits(o: {
  chain: SourceChain
  tuple: OxideEnvTuple
  sourceTuples: readonly OxideEnvTuple[]
  publicClient: PublicClient
  masterSecret: FieldLike
  scanHead: bigint
  onUnverified?: (move: SourceSavingsMove) => void
}) {
  const moves: SourceSavingsMove[] = []
  for (const tuple of o.sourceTuples) {
    if (tuple.rollupVersion !== o.tuple.rollupVersion) continue
    if (o.chain.kind === "generation") {
      moves.push(...(await o.chain.session.savingsMoves({ tuple })))
    } else {
      if (!tuple.plainWithdrawalExecutor)
        throw new Error("The source deployment has no withdrawal executor")
      const source = createWithdrawEventSource({
        wallet: o.chain.wallet,
        portal: await portalContract(o.publicClient, tuple.portal as Address).getPortalDomain(),
        accountAddress: o.chain.account.getAddress().toString(),
        readExecutor: (address) =>
          readWithdrawalExecutor(
            o.publicClient,
            address,
            o.sourceTuples.some((source) =>
              source.features?.some(
                (feature) =>
                  feature.project === "sky" &&
                  feature.contracts.skyWithdrawalExecutor?.toLowerCase() === address.toLowerCase(),
              ),
            )
              ? "sky"
              : "plain",
          ),
      })
      const events = await source.listWithdrawals(1, (await source.headBlock()) + 1)
      moves.push(
        ...events.flatMap(({ sky }) =>
          sky
            ? [
                {
                  direction: sky.route === savingsRoute("in") ? ("in" as const) : ("out" as const),
                  factory: sky.factory,
                  nonce: sky.nonce,
                  recipientCommitment: sky.recipientCommitment,
                },
              ]
            : [],
        ),
      )
    }
  }
  const range = await deploymentScanRange(o.publicClient, o.tuple, o.scanHead)
  return refundableSavingsDeposits({
    publicClient: o.publicClient,
    portal: o.tuple.portal as Address,
    recipient:
      o.chain.kind === "generation"
        ? o.chain.session.address
        : o.chain.account.getAddress().toString(),
    masterSecret: o.masterSecret,
    moves,
    fromBlock: range.fromBlock,
    head: range.toBlock,
    onUnverified: o.onUnverified,
  })
}
