import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { SavingsPosition, SavingsSource } from "../core/services/savings/types"
import { useCachedRecords } from "../hooks/useCachedRecords"

export const SAVINGS_READ_INTERVAL_MS = 60_000

const NO_MOVES = { load: async () => {}, list: () => [], onListChanged: () => () => {} }

interface SavingsContextValue {
  /** Null where the profile lists no savings asset; `useSavings` then reports `available: false`. */
  source: SavingsSource | null
  position: SavingsPosition | null
  /** True once the first read has answered, with a figure or not. */
  hydrated: boolean
  refresh(): Promise<void>
}

const SavingsContext = createContext<SavingsContextValue>({
  source: null,
  position: null,
  hydrated: false,
  refresh: async () => {},
})

/** Holds the source and one position read for every Savings surface, re-read on a cadence and after each claim. */
export function SavingsProvider({
  source,
  children,
}: {
  source: SavingsSource | null
  children: ReactNode
}) {
  const { records: moves } = useCachedRecords(source?.moves ?? NO_MOVES)
  // Tagged with its source, so a new source starts unread; only the latest read lands.
  const [read, setRead] = useState<{ source: SavingsSource; position: SavingsPosition | null }>()
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    if (!source) return
    const id = ++latest.current
    let position: SavingsPosition | null | undefined
    try {
      position = await source.read()
    } catch (err) {
      console.warn("[useSavings] position read failed:", err)
    }
    if (id !== latest.current) return
    setRead((prev) => ({
      source,
      position: position ?? (prev?.source === source ? prev.position : null),
    }))
  }, [source])
  const current = read?.source === source ? read : undefined
  const position = current?.position ?? null
  const hydrated = !!current
  const claimed = moves.filter((move) => move.deposit?.claimed).length
  useEffect(() => {
    if (!source) return
    void refresh()
    const timer = setInterval(() => void refresh(), SAVINGS_READ_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, refresh, claimed])
  const value = useMemo(
    () => ({ source, position, hydrated, refresh }),
    [source, position, hydrated, refresh],
  )
  return <SavingsContext.Provider value={value}>{children}</SavingsContext.Provider>
}

export const useSavingsSource = (): SavingsSource | null => useContext(SavingsContext).source

/** The shared position: what the shares are worth and the vault's share price. */
export function useSavingsPosition(): Pick<
  SavingsContextValue,
  "position" | "hydrated" | "refresh"
> {
  const { position, hydrated, refresh } = useContext(SavingsContext)
  return { position, hydrated, refresh }
}
