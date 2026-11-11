import { decodePaylinkInline, readPaylinkEscrowNote } from "@obsidion/sdk"
import type { ContractService, ObsidionWallet } from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { PageFacts } from "../../session/pageChain"
import { findHistoricTuple } from "../migration/historicTokenContext"

export async function paylinkTuple(page: PageFacts, tokenAddress: string): Promise<OxideEnvTuple> {
  const active = await page.chain.oxideTuple.read()
  if (active.l2Token.toLowerCase() === tokenAddress.toLowerCase()) return active
  const source = await findHistoricTuple(page.config, tokenAddress)
  if (!source) throw new Error("This link's token deployment is unavailable")
  return source
}

export async function readPaylinkSource(
  deps: { wallet: ObsidionWallet; contractService: ContractService },
  fragment: string,
  page: PageFacts,
) {
  const params = decodePaylinkInline(fragment)
  const note = await readPaylinkEscrowNote(deps, params)
  const tuple = await paylinkTuple(page, note.tokenAddress.toString())
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
