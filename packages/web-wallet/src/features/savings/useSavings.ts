import { useAfter, useStore, type After, type SavingsHolding } from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { useSavingsAsset } from "./savingsGateway"

/** The Savings surfaces show after the first balance. */
const SHOWN_AFTER: After = { firstBalance: true }

/**
 * The session's Savings for a view: the shares held at the vault's price, and whether Savings shows.
 * It shows once the first balance is in, where the profile has Savings.
 */
export function useSavings(): SavingsHolding & { available: boolean } {
  const { milestones, savingsHolding } = useSession()
  const shown = useAfter(milestones, SHOWN_AFTER)
  const exists = !!useSavingsAsset()
  return { available: shown && exists, ...useStore(savingsHolding) }
}
