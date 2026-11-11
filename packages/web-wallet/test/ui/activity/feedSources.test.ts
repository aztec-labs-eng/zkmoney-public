// @vitest-environment node
/** What the recent people read: the newest transfers merged with the feed's, and every request. */
import { describe, expect, it, vi } from "vitest"
import {
  memoryStore,
  type PaymentRequest,
  type RecordSet,
  type Requests,
  type SipaDeposit,
  type SipaDeposits,
  type Transaction,
  type Transfers,
  type WithdrawalRecord,
  type Withdrawals,
} from "@obsidion/front-core"
import { contactActivity } from "../../../src/ui/activity/feedSources"

const set = <R>(records: R[], loaded = true) => ({ records, loaded, failed: false })
const row = (id: string) => ({ id } as Transaction)

describe("contactActivity", () => {
  it("merges the newest transfers with the feed's, and passes the other records through", () => {
    const where = vi.fn(() => memoryStore(set([row("a"), row("b")])))
    const requests = [{ id: "r1" }] as PaymentRequest[]
    const deposits = [{ sipaAddress: "0xd" }] as unknown as SipaDeposit[]
    const burns = [{ localId: "w1" }] as WithdrawalRecord[]
    const sources = contactActivity(
      { where } as unknown as Transfers,
      { transfers: memoryStore(set([row("b"), row("c")])) },
      { view: memoryStore(requests), settled: memoryStore(true) } as unknown as Requests,
      {
        list: memoryStore({ records: burns, hydrated: true }),
        settled: memoryStore(true),
      } as unknown as Withdrawals,
      { view: memoryStore(set(deposits)) } as unknown as SipaDeposits,
    ).get()
    expect(where).toHaveBeenCalledWith("time", { reverse: true, limit: 100 })
    expect(sources.transactions?.map((t) => t.id)).toEqual(["a", "b", "c"])
    expect([sources.requests, sources.sipaDeposits, sources.withdrawals]).toEqual([
      requests,
      deposits,
      burns,
    ])
  })

  const read = { records: [], loaded: true, failed: false }
  const unread = { records: [], loaded: false, failed: false }
  const failed = { records: [], loaded: false, failed: true }
  const all = { transfers: read, own: read, deposits: read, requests: true, burns: true }

  it.each([
    ["every source is read", all, true],
    ["reads failed", { ...all, transfers: failed, deposits: failed }, true],
    ["transfers load", { ...all, transfers: unread }, false],
    ["this device's transfers failed and the rest load", { ...all, own: failed, transfers: unread }, false],
    ["deposits load", { ...all, deposits: unread }, false],
    ["requests load", { ...all, requests: false }, false],
    ["withdrawals load", { ...all, burns: false }, false],
  ])("hydrated while %s", (_, state, hydrated) => {
    const sources = contactActivity(
      { where: () => memoryStore<RecordSet<Transaction>>(state.transfers) } as unknown as Transfers,
      { transfers: memoryStore<RecordSet<Transaction>>(state.own) },
      {
        view: memoryStore([]),
        settled: memoryStore(state.requests),
      } as unknown as Requests,
      {
        list: memoryStore({ records: [], hydrated: state.burns }),
        settled: memoryStore(state.burns),
      } as unknown as Withdrawals,
      { view: memoryStore<RecordSet<SipaDeposit>>(state.deposits) } as unknown as SipaDeposits,
    ).get()
    expect(sources.hydrated).toBe(hydrated)
  })
})
