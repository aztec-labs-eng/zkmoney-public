import { WalletError } from "@obsidion/core/errors"
import type {
  SavingsDirection,
  SavingsMoveRecord,
  SavingsMoveStage,
  SavingsQuote,
  SavingsSource,
} from "@obsidion/front-core"
import type { Session } from "../../session/session"

/** The session's Savings once it is open. The move sheet opens only where Savings exists. */
async function openedSavings(
  session: Pick<Session, "savings">,
  signal: AbortSignal,
): Promise<SavingsSource> {
  const source = await session.savings?.ready(signal)
  if (!source) throw new WalletError("invariant", "a Savings move without Savings")
  return source
}

/** What moving `amount` lands, and what it costs. */
export const quoteSavings = async (
  session: Pick<Session, "savings">,
  direction: SavingsDirection,
  amount: bigint,
  signal: AbortSignal,
): Promise<SavingsQuote> => (await openedSavings(session, signal)).quote(direction, amount)

/** Moves `amount` between Main and Savings; the settle pass claims it once the relayer runs it. */
export const moveSavings = async (
  session: Pick<Session, "savings">,
  direction: SavingsDirection,
  amount: bigint,
  onStage: (stage: SavingsMoveStage) => void,
  signal: AbortSignal,
): Promise<SavingsMoveRecord> =>
  (await openedSavings(session, signal)).move(direction, amount, onStage)
