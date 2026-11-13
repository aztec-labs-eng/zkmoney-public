// The L1 reads every rail's port makes the same way: a move's deposit and release on its portals,
// a token's figures, and the L1 clock.
import { isWithdrawalSpent, readPortalDeposits, readWithdrawalRelease } from "@obsidion/sdk"
import { computeRecipientCommitment } from "@oxide/oxide-lib/recipient_commitment.js"
import { erc20Abi } from "viem"
import type { Address, Hex, PublicClient } from "viem"
import type { MoveDirection } from "../../../engine/moveTransition"
import { findBlockAtTime } from "../../../oxide/deploymentScanRange"
import type { MoveRoute, MoveRoutes, RouteHolding } from "./types"

export type MoveReadsL1 = Pick<
  PublicClient,
  "getBlock" | "getBlockNumber" | "getContractEvents" | "readContract"
>

/** The portal a move in `direction` burns from, and the one its route deposits into. */
export const movePortals = (route: MoveRoute, direction: MoveDirection) =>
  direction === "in"
    ? { source: route.base.portal, destination: route.held.portal }
    : { source: route.held.portal, destination: route.base.portal }

export function l1MoveReads(
  l1: MoveReadsL1,
): Pick<
  MoveRoutes<RouteHolding, MoveRoute>,
  "commitment" | "findDeposit" | "withdrawalSpent" | "release" | "token" | "head" | "blockAt"
> {
  return {
    commitment: async (secret, recipient) =>
      (await computeRecipientCommitment(secret, recipient)).toString() as Hex,

    findDeposit: async (route, direction, recipientCommitment, range, signal) => {
      signal?.throwIfAborted()
      const { destination } = movePortals(route, direction)
      const [found] = await readPortalDeposits(
        l1,
        [destination],
        [recipientCommitment],
        range.from,
        range.to,
      )
      signal?.throwIfAborted()
      if (!found) return undefined
      const { timestamp } = await l1.getBlock({ blockNumber: found.blockNumber })
      signal?.throwIfAborted()
      return {
        deposit: {
          inboxIndex: found.index,
          amount: found.amount,
          messageKey: found.key,
          at: Number(timestamp) * 1000,
        },
        txHash: found.txHash,
        blockNumber: found.blockNumber,
      }
    },

    withdrawalSpent: (route, direction, withdrawalId) =>
      isWithdrawalSpent(l1, movePortals(route, direction).source, withdrawalId),

    release: async (route, direction, withdrawalId, range) => {
      const { source } = movePortals(route, direction)
      const found = await readWithdrawalRelease(l1, source, withdrawalId, range.from, range.to)
      if (!found) return undefined
      const { timestamp } = await l1.getBlock({ blockNumber: found.blockNumber })
      return { txHash: found.txHash, at: Number(timestamp) * 1000 }
    },

    token: async (address: Address) => {
      const [symbol, decimals] = await Promise.all([
        l1.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
        l1.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
      ])
      return { symbol, decimals }
    },

    head: () => l1.getBlockNumber(),

    blockAt: async (timeMs) => {
      const head = await l1.getBlockNumber()
      return (await findBlockAtTime(l1, Math.ceil(timeMs / 1000), head)) ?? head
    },
  }
}
