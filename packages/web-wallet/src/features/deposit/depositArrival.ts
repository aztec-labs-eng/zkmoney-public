import { useEffect, useState } from "react"
import type { AztecNode } from "@aztec/aztec.js/node"
import { InboxAbi } from "@aztec/l1-artifacts/InboxAbi"
import { depositArrivalMinutes, depositArrivalSeconds } from "@obsidion/front-core"
import type { Hex } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/** How often the figure is recomputed, so it follows the slot grid. */
const TICK_MS = 30_000

export interface ArrivalGrid {
  l1GenesisTime: number
  slotDuration: number
  inboxLag: number
}

/** The rollup's slot grid and the Inbox's checkpoint lag. Both reads start inside the chain, so a node that throws on call rejects. */
export async function loadArrivalGrid(
  node: Pick<AztecNode, "getL1ContractAddresses" | "getL1Constants">,
  config: WebWalletConfig,
): Promise<ArrivalGrid> {
  const lag = Promise.resolve()
    .then(() => node.getL1ContractAddresses())
    .then((addresses) =>
      l1PublicClient(config).readContract({
        address: addresses.inboxAddress.toString() as Hex,
        abi: InboxAbi,
        functionName: "LAG",
      }),
    )
  const [constants, inboxLag] = await Promise.all([
    Promise.resolve().then(() => node.getL1Constants()),
    lag,
  ])
  return {
    l1GenesisTime: Number(constants.l1GenesisTime),
    slotDuration: constants.slotDuration,
    inboxLag: Number(inboxLag),
  }
}

/**
 * Minutes until a deposit spotted now would credit the balance, from the rollup's slot grid and the
 * Inbox's checkpoint lag. Unknown while the reads are out or once one failed.
 */
export function useDepositArrivalMinutes(
  node: AztecNode | undefined,
  config: WebWalletConfig,
): number | undefined {
  const [grid, setGrid] = useState<ArrivalGrid>()
  useEffect(() => {
    if (!node) return
    let live = true
    loadArrivalGrid(node, config).then(
      (loaded) => live && setGrid(loaded),
      () => {},
    )
    return () => {
      live = false
    }
  }, [node, config])

  const [minutes, setMinutes] = useState<number>()
  useEffect(() => {
    if (!grid) return
    const compute = () =>
      setMinutes(
        depositArrivalMinutes(
          depositArrivalSeconds({ nowSeconds: Math.floor(Date.now() / 1000), ...grid }),
        ),
      )
    compute()
    const timer = setInterval(compute, TICK_MS)
    return () => clearInterval(timer)
  }, [grid])
  return minutes
}
