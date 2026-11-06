import { describe, expect, it } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import type { CachedRecordSource } from "../../src/hooks/useCachedRecords"
import { useCachedRecords } from "../../src/hooks/useCachedRecords"

interface Rec {
  id: string
}

/** Minimal RecordStorage stand-in with a controllable load. */
function makeSource(initial: Rec[] = []) {
  let records = initial
  const listeners = new Set<(records: Rec[]) => void>()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const source: CachedRecordSource<Rec> & { fail?: boolean } = {
    load: async () => {
      await gate
      if (source.fail) throw new Error("storage broken")
    },
    list: () => records,
    onListChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const write = (next: Rec[]) => {
    records = next
    for (const listener of listeners) listener(records)
  }
  return { source, write, release }
}

describe("useCachedRecords", () => {
  it("serves the store's current state immediately and flips hydrated after load", async () => {
    const { source, write, release } = makeSource([{ id: "cached" }])

    const { result } = renderHook(() => useCachedRecords(source))
    expect(result.current.records).toEqual([{ id: "cached" }])
    expect(result.current.hydrated).toBe(false)

    act(() => write([{ id: "cached" }, { id: "from-storage" }]))
    release()
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    expect(result.current.records).toEqual([{ id: "cached" }, { id: "from-storage" }])
  })

  it("re-renders when a live writer overwrites records after hydration", async () => {
    const { source, write, release } = makeSource()
    release()

    const { result } = renderHook(() => useCachedRecords(source))
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    expect(result.current.records).toEqual([])

    act(() => write([{ id: "fresh" }]))
    expect(result.current.records).toEqual([{ id: "fresh" }])
  })

  it("flips hydrated even when the load fails", async () => {
    const { source, release } = makeSource()
    source.fail = true
    release()

    const { result } = renderHook(() => useCachedRecords(source))
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    expect(result.current.records).toEqual([])
    expect(result.current.failed).toBe(true)
  })

  it("reports a load that read nothing as failed, and a clean one as not", async () => {
    const { source, release } = makeSource()
    let loaded = false
    const retrying = { ...source, isLoaded: () => loaded }
    release()

    const unread = renderHook(() => useCachedRecords(retrying))
    await waitFor(() => expect(unread.result.current.hydrated).toBe(true))
    expect(unread.result.current.failed).toBe(true)

    loaded = true
    const read = renderHook(() => useCachedRecords({ ...retrying }))
    await waitFor(() => expect(read.result.current.hydrated).toBe(true))
    expect(read.result.current.failed).toBe(false)
  })

  it("clears failed once another reader's load reads storage", async () => {
    const { source, write, release } = makeSource()
    let loaded = false
    const retrying = { ...source, isLoaded: () => loaded }
    release()

    const { result } = renderHook(() => useCachedRecords(retrying))
    await waitFor(() => expect(result.current.failed).toBe(true))
    // A write before any read landed keeps it failed.
    act(() => write([{ id: "written" }]))
    expect(result.current.failed).toBe(true)

    loaded = true
    act(() => write([{ id: "written" }, { id: "read" }]))
    expect(result.current.failed).toBe(false)
  })

  it("reads again on retry, failed until that read answers", async () => {
    let loaded = false
    let answer: () => void = () => {}
    const source: CachedRecordSource<Rec> = {
      load: () => new Promise<void>((resolve) => (answer = resolve)),
      isLoaded: () => loaded,
      list: () => [],
      onListChanged: () => () => {},
    }
    const { result } = renderHook(() => useCachedRecords(source))
    act(() => answer())
    await waitFor(() => expect(result.current.failed).toBe(true))

    loaded = true
    act(() => result.current.retry())
    expect(result.current.failed).toBe(true)
    act(() => answer())
    await waitFor(() => expect(result.current.failed).toBe(false))
  })

  it("stops updating after unmount", async () => {
    const { source, write, release } = makeSource()
    release()

    const { result, unmount } = renderHook(() => useCachedRecords(source))
    await waitFor(() => expect(result.current.hydrated).toBe(true))
    unmount()
    // Writing after unmount must not throw (listener removed, load settled).
    write([{ id: "late" }])
    expect(result.current.records).toEqual([])
  })
})
