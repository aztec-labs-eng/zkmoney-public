import { useEffect, useState } from "react"
import type { AztecNode } from "@aztec-labs/aztec.js/node"
import { depositArrivalMinutes, depositArrivalSeconds } from "@obsidion/front-core"

/** How often the figure is recomputed, so it follows the slot grid. */
const TICK_MS = 30_000

export interface ArrivalGrid {
  l1GenesisTime: number
  slotDuration: number
}

/** The rollup's slot grid. The read starts inside the chain, so a node that throws on call rejects. */
export async function loadArrivalGrid(
  node: Pick<AztecNode, "getL1Constants">,
): Promise<ArrivalGrid> {
  const constants = await Promise.resolve().then(() => node.getL1Constants())
  return { l1GenesisTime: Number(constants.l1GenesisTime), slotDuration: constants.slotDuration }
}

/**
 * Minutes until a deposit spotted now would credit the balance, from the rollup's slot grid.
 * Unknown while the read is out or once it failed.
 */
export function useDepositArrivalMinutes(node: AztecNode | undefined): number | undefined {
  const [grid, setGrid] = useState<ArrivalGrid>()
  useEffect(() => {
    if (!node) return
    let live = true
    loadArrivalGrid(node).then(
      (loaded) => live && setGrid(loaded),
      () => {},
    )
    return () => {
      live = false
    }
  }, [node])

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
