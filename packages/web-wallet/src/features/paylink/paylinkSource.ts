import { decodePaylinkInline, readPaylinkEscrowNote } from "@obsidion/sdk"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"
import { findHistoricTuple } from "../migration/historicTokenContext"

export async function paylinkTuple(tokenAddress: string): Promise<OxideEnvTuple> {
  const active = await getOxideTuple(getConfig())
  if (active.l2Token.toLowerCase() === tokenAddress.toLowerCase()) return active
  const source = await findHistoricTuple(tokenAddress)
  if (!source) throw new Error("This link's token deployment is unavailable")
  return source
}

export async function readPaylinkSource(
  deps: { wallet: ObsidionWallet; contractService: ContractService },
  fragment: string,
) {
  const params = decodePaylinkInline(fragment)
  const note = await readPaylinkEscrowNote(deps, params)
  const tuple = await paylinkTuple(note.tokenAddress.toString())
  return { params, note, tuple }
}

export function assertPaylinkSwapSource(
  swap: { source: { portal: string; l2Token: string } } | undefined,
  tuple: OxideEnvTuple,
): void {
  if (
    swap &&
    (swap.source.portal.toLowerCase() !== tuple.portal.toLowerCase() ||
      swap.source.l2Token.toLowerCase() !== tuple.l2Token.toLowerCase())
  ) {
    throw new Error("The swap plan belongs to another token deployment")
  }
}
