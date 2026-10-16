import { useCallback } from "react"
import { useSavingsPosition, useSavingsSource } from "../contexts/useSavingsContext"
import type {
  SavingsDirection,
  SavingsMoveRecord,
  SavingsMoveStage,
  SavingsPosition,
  SavingsQuote,
} from "../core/services/savings/types"
import { useCachedRecords, type CachedRecordSource } from "./useCachedRecords"

const NO_MOVES: CachedRecordSource<SavingsMoveRecord> = {
  load: async () => {},
  list: () => [],
  onListChanged: () => () => {},
}

export interface SavingsState {
  /** False where the profile lists no savings asset. */
  available: boolean
  position: SavingsPosition | null
  /** True once the first read has answered, with a figure or not. */
  hydrated: boolean
  /** Newest first. */
  moves: SavingsMoveRecord[]
  refresh(): Promise<void>
  quote(direction: SavingsDirection, amount: bigint): Promise<SavingsQuote>
  move(
    direction: SavingsDirection,
    amount: bigint,
    onStage: (stage: SavingsMoveStage) => void,
  ): Promise<SavingsMoveRecord>
}

/** The Savings position and moves over the composed source. */
export function useSavings(): SavingsState {
  const source = useSavingsSource()
  const { position, hydrated, refresh } = useSavingsPosition()
  const { records: moves } = useCachedRecords(source?.moves ?? NO_MOVES)
  const quote = useCallback<SavingsState["quote"]>(
    (direction, amount) => {
      if (!source) throw new Error("Savings is not available")
      return source.quote(direction, amount)
    },
    [source],
  )
  const move = useCallback<SavingsState["move"]>(
    async (direction, amount, onStage) => {
      if (!source) throw new Error("Savings is not available")
      const record = await source.move(direction, amount, onStage)
      void refresh()
      return record
    },
    [source, refresh],
  )
  return { available: source !== null, position, hydrated, moves, refresh, quote, move }
}
