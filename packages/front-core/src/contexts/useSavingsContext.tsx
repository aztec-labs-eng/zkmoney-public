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
import { BalanceStorage } from "../core/storages/BalanceStorage"
import { savingsValue } from "../core/services/savings/savingsMath"
import type { SavingsPosition, SavingsPrice, SavingsSource } from "../core/services/savings/types"
import { useCachedRecords } from "../hooks/useCachedRecords"

export const SAVINGS_PRICE_INTERVAL_MS = 60_000

const NO_BALANCES = { load: async () => {}, list: () => [], onListChanged: () => () => {} }

interface SavingsContextValue {
  /** Null where the profile lists no savings asset; `useSavings` then reports `available: false`. */
  source: SavingsSource | null
  position: SavingsPosition | null
  /** True once the shares held are known and the first price read has answered, with a price or not. */
  hydrated: boolean
  refresh(): Promise<void>
}

const SavingsContext = createContext<SavingsContextValue>({
  source: null,
  position: null,
  hydrated: false,
  refresh: async () => {},
})

/**
 * Holds the Savings position for every Savings surface: the shares the wallet's sync keeps in the
 * balance store, as Main's balance, valued at the vault's share price read on L1 on a cadence.
 */
export function SavingsProvider({
  source,
  children,
}: {
  source: SavingsSource | null
  children: ReactNode
}) {
  const { records: balances } = useCachedRecords(
    useMemo(() => (source ? BalanceStorage.get() : NO_BALANCES), [source]),
  )
  const record =
    source &&
    balances.find(
      (b) => b.scope === source.balance.scope && b.tokenAddress === source.balance.tokenAddress,
    )
  const shares = useMemo(() => {
    try {
      return record ? BigInt(record.balance) : undefined
    } catch {
      return undefined
    }
  }, [record])

  // Tagged with its source, so a new source starts unread; only the latest read lands.
  const [read, setRead] = useState<{ source: SavingsSource; price: SavingsPrice | null }>()
  const latest = useRef(0)
  const refresh = useCallback(async () => {
    if (!source) return
    const id = ++latest.current
    let price: SavingsPrice | undefined
    try {
      price = await source.readPrice()
    } catch (err) {
      console.warn("[useSavings] price read failed:", err)
    }
    if (id !== latest.current) return
    setRead((prev) => ({
      source,
      price: price ?? (prev?.source === source ? prev.price : null),
    }))
  }, [source])
  useEffect(() => {
    if (!source) return
    void refresh()
    const timer = setInterval(() => void refresh(), SAVINGS_PRICE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [source, refresh])

  const price = read?.source === source ? read.price : undefined
  const hydrated = price !== undefined && shares !== undefined
  const position = useMemo<SavingsPosition | null>(
    () =>
      price && shares !== undefined
        ? {
            shares,
            value: savingsValue(shares, price.sharePrice),
            ...price,
            sharesReadAt: record?.readAt ?? record?.updatedAt,
          }
        : null,
    [price, shares, record?.readAt, record?.updatedAt],
  )
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
