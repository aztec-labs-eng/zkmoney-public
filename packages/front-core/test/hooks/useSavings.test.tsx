import { describe, expect, it, vi } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { SavingsProvider } from "../../src/contexts/useSavingsContext"
import { useSavings } from "../../src/hooks/useSavings"
import type {
  SavingsMoveRecord,
  SavingsPosition,
  SavingsSource,
} from "../../src/core/services/savings/types"

function fakeSource(initial: SavingsMoveRecord[] = []) {
  let records = initial
  const listeners = new Set<(records: SavingsMoveRecord[]) => void>()
  let reads = 0
  const source = {
    moves: {
      load: async () => {},
      list: () => records,
      onListChanged: (listener: (records: SavingsMoveRecord[]) => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    read: vi.fn(async (): Promise<SavingsPosition> => {
      reads += 1
      return {
        shares: 10n,
        value: BigInt(reads) * 11n,
        sharePrice: 10n ** 18n,
        apy: 0.05,
        readAt: reads,
      }
    }),
    quote: vi.fn(),
    move: vi.fn(async (direction, amount) => ({ direction, amount: String(amount) })),
    settle: vi.fn(),
  } as unknown as SavingsSource
  const write = (next: SavingsMoveRecord[]) => {
    records = next
    for (const listener of listeners) listener(records)
  }
  return { source, write }
}

const wrap =
  (source: SavingsSource | null) =>
  ({ children }: { children: ReactNode }) =>
    <SavingsProvider source={source}>{children}</SavingsProvider>

describe("useSavings", () => {
  it("reports no Savings without a source", () => {
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(null) })
    expect(result.current.available).toBe(false)
    expect(result.current.position).toBeNull()
    expect(result.current.moves).toEqual([])
  })

  it("reads the position once, lists the store's moves, and re-reads after a claim", async () => {
    const pending = { withdrawalLocalId: "w1", direction: "in", startTime: 1 } as SavingsMoveRecord
    const { source, write } = fakeSource([pending])
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    expect(result.current.available).toBe(true)
    expect(result.current.position?.value).toBe(11n)
    expect(result.current.moves).toEqual([pending])
    expect(source.read).toHaveBeenCalledTimes(1)

    act(() => write([{ ...pending, deposit: { inboxIndex: "1", amount: "2", claimed: true } }]))
    await waitFor(() => expect(result.current.position?.value).toBe(22n))
  })

  it("re-reads after a move is sent", async () => {
    const { source } = fakeSource()
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    await act(async () => {
      await result.current.move("in", 5n, () => {})
    })
    expect(source.move).toHaveBeenCalledWith("in", 5n, expect.any(Function))
    await waitFor(() => expect(source.read).toHaveBeenCalledTimes(2))
  })

  it("drops a slow read from the source it replaced, and starts the new source unread", async () => {
    const position = (value: bigint): SavingsPosition => ({
      shares: 1n,
      value,
      sharePrice: 10n ** 18n,
      readAt: 0,
    })
    let answerOld!: (p: SavingsPosition) => void
    const { source: old } = fakeSource()
    vi.mocked(old.read).mockImplementation(() => new Promise((resolve) => (answerOld = resolve)))
    const { source: next } = fakeSource()
    let answerNext!: (p: SavingsPosition) => void
    vi.mocked(next.read).mockImplementation(() => new Promise((resolve) => (answerNext = resolve)))
    let current: SavingsSource = old
    const { result, rerender } = renderHook(() => useSavings(), {
      wrapper: ({ children }) => <SavingsProvider source={current}>{children}</SavingsProvider>,
    })
    current = next
    rerender()
    expect(result.current.hydrated).toBe(false)
    await act(async () => answerNext(position(7n)))
    await act(async () => answerOld(position(99n)))
    expect(result.current.position?.value).toBe(7n)
  })

  it("keeps the latest of two overlapping reads", async () => {
    const { source } = fakeSource()
    const answers: ((value: bigint) => void)[] = []
    vi.mocked(source.read).mockImplementation(
      () =>
        new Promise((resolve) =>
          answers.push((value) => resolve({ shares: 1n, value, sharePrice: 1n, readAt: 0 })),
        ),
    )
    const { result } = renderHook(() => useSavings(), { wrapper: wrap(source) })
    await waitFor(() => expect(answers).toHaveLength(1))
    act(() => void result.current.refresh())
    await act(async () => answers[1](2n))
    await act(async () => answers[0](1n))
    expect(result.current.position?.value).toBe(2n)
  })
})
