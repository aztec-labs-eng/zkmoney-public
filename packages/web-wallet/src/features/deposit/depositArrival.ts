import type { AztecNode } from "@aztec-labs/aztec.js/node"
import {
  depositArrivalMinutes,
  depositArrivalSeconds,
  memoryStore,
  useStore,
} from "@obsidion/front-core"
import { useSession } from "../../session/session"

/** A clock that never ticks, read where nothing waits on the time. */
export const NO_CLOCK = memoryStore(0).readonly

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
export function useDepositArrivalMinutes(): number | undefined {
  const { page } = useSession()
  const read = useStore(page.slotGrid)
  const grid = read.status === "ready" ? read.value : undefined
  // The clock ticks only once the grid is read.
  const { wallClock } = page
  const nowSeconds = Math.floor(useStore(grid ? wallClock : NO_CLOCK) / 1000)
  return grid && depositArrivalMinutes(depositArrivalSeconds({ nowSeconds, ...grid }))
}
