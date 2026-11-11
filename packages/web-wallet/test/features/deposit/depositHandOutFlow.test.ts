// @vitest-environment node
/**
 * The deposit screen's hand-out over a fake address source that refuses a pool read on an empty
 * pool and derives on an answer the case holds. Its refusals run against the real source too.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { WalletError } from "@obsidion/core/errors"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createSipaDeposits,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  service,
  type SipaDeposit,
} from "@obsidion/front-core"
import type { Address } from "viem"
import { subscribeErrorModal, type ErrorModalPayload } from "../../../src/errors/errorModal"
import { AddressesPublishingError } from "../../../src/features/deposit/addressesPublishing"
import { openDepositHandOutFlow } from "../../../src/features/deposit/depositHandOutFlow"
import {
  createSipaAddresses,
  type SipaAddresses,
} from "../../../src/features/deposit/sipaAddresses"
import type { SipaKeys } from "../../../src/features/deposit/sipaRail"
import type { DepositAddress } from "../../../src/features/sipa/depositTarget"
import { defaultConfig } from "../../support/page"
import { answered } from "../../support/query"

const ACCOUNT = `0x${"a1".repeat(32)}`
const ADDRESS = "0x00000000000000000000000000000000000000c1" as Address
const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
} as OxideEnvTuple

type Source = Pick<SipaAddresses, "depositAddress">

/** An empty pool, and derivations the case answers in order. */
function fakeSource() {
  const pending: { resolve(a: DepositAddress): void; reject(e: unknown): void }[] = []
  const source: Source = {
    async depositAddress(_tag, opts) {
      if (opts?.publishingLimit === 0) throw new AddressesPublishingError()
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject })
        opts?.signal?.addEventListener("abort", () => reject(new WalletError("aborted")))
      })
    },
  }
  return { source, pending }
}

let modals: ErrorModalPayload[] = []
let unsubscribe = () => {}
beforeAll(() => {
  unsubscribe = subscribeErrorModal((p) => modals.push(p))
  return () => unsubscribe()
})
afterEach(() => {
  modals = []
})

/** A shown address whose broadcast has not landed: the publishing limit counts it. */
const publishing = (n: number, state: "queued" | "landed" = "queued") =>
  ({
    sipaAddress: `0x${n.toString(16).padStart(40, "0")}`,
    broadcast: { kind: "deposit", source: { type: "slot" }, state, createdAt: 1, failures: 0 },
  } as SipaDeposit)

function open(source: Source, held: SipaDeposit[] = [], sheetOpen = false) {
  const records = memoryStore({ records: held })
  const live = () => ({ handle: "alice", account: ACCOUNT, addresses: source, sheetOpen })
  const flow = openDepositHandOutFlow(live, records.readonly, String)
  const screen = new AbortController()
  flow.start(screen.signal)
  return { flow, screen, records }
}

describe("depositHandOutFlow", () => {
  it("derives one address however many callers ask, a StrictMode replay among them", async () => {
    const { source, pending } = fakeSource()
    const { flow, screen } = open(source)
    const asks = [flow.handOut(0)]
    // StrictMode ends the first start and starts again, and the open asks twice.
    screen.abort()
    flow.start(new AbortController().signal)
    asks.push(flow.handOut(0), flow.handOut(), flow.handOut())
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.resolve({ address: ADDRESS, name: "alice", source: "derived" })

    expect(await Promise.all(asks)).toEqual([false, false, true, true])
    // Asked after the address is held, before any view re-renders.
    expect(await flow.handOut()).toBe(true)
    expect(pending).toHaveLength(1)
    expect(flow.state.get()).toMatchObject({ address: { address: ADDRESS }, running: undefined })
  })

  it("reports a failed derivation once, and derives again on the next ask", async () => {
    const { source, pending } = fakeSource()
    const { flow } = open(source)
    const first = flow.handOut()
    await vi.waitFor(() => expect(pending).toHaveLength(1))
    pending[0]!.reject(new WalletError("unknown"))
    expect(await first).toBe(false)
    expect(flow.state.get().failed).toBe(true)
    expect(modals).toHaveLength(1)

    const second = flow.handOut()
    expect(flow.state.get().failed).toBe(false)
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1]!.resolve({ address: ADDRESS, name: "alice", source: "derived" })
    expect(await second).toBe(true)
  })

  it("holds a refused derivation as capped until a counted address lands, then hands out", async () => {
    let refuse = true
    const source: Source = {
      depositAddress: async () => {
        if (refuse) throw new AddressesPublishingError()
        return { address: ADDRESS, name: "alice", source: "derived" }
      },
    }
    const { flow, records } = open(source, [publishing(1), publishing(2)], true)
    expect(await flow.handOut()).toBe(false)
    expect(flow.state.get().capped).toBe(true)
    expect(modals).toEqual([])

    // Activity that frees nothing keeps it capped.
    records.set({ records: [publishing(1), publishing(2), publishing(3, "landed")] })
    expect(flow.state.get().capped).toBe(true)

    refuse = false
    records.set({ records: [publishing(1, "landed"), publishing(2)] })
    expect(flow.state.get().capped).toBe(false)
    await vi.waitFor(() => expect(flow.state.get().address?.address).toBe(ADDRESS))
  })

  it("stays capped while the self window's slots are all unpublished, and hands out once one lands", async () => {
    let refuse = true
    const source: Source = {
      depositAddress: async () => {
        if (refuse) throw new AddressesPublishingError()
        return { address: ADDRESS, name: "alice", source: "derived" }
      },
    }
    const today = Math.floor(Date.now() / 86_400_000)
    const own = (n: number, state: "queued" | "landed" = "queued") =>
      ({
        ...publishing(n, state),
        recipientL2Address: ACCOUNT,
        slot: { day: today, nonce: n },
        broadcast: { ...publishing(n, state).broadcast!, fundedAt: 2 },
      } as SipaDeposit)
    const { flow, records } = open(source, [own(1), own(2), own(3)], true)
    expect(await flow.handOut()).toBe(false)
    records.set({ records: [own(1), own(2), own(3)] })
    expect(flow.state.get().capped).toBe(true)

    refuse = false
    records.set({ records: [own(1, "landed"), own(2), own(3)] })
    await vi.waitFor(() => expect(flow.state.get().address?.address).toBe(ADDRESS))
  })

  it("hands out again at once when the limit freed before the refusal came back", async () => {
    let refuse = true
    const source: Source = {
      depositAddress: async () => {
        if (!refuse) return { address: ADDRESS, name: "alice", source: "derived" }
        refuse = false
        throw new AddressesPublishingError()
      },
    }
    const { flow } = open(source, [], true)
    expect(await flow.handOut()).toBe(false)
    await vi.waitFor(() => expect(flow.state.get().address?.address).toBe(ADDRESS))
    expect(flow.state.get().capped).toBe(false)
  })

  it("keeps a failed pool read quiet: no report and no failed state", async () => {
    const { flow } = open({
      depositAddress: async () => {
        throw new WalletError("unknown")
      },
    })
    expect(await flow.handOut(0)).toBe(false)
    expect(flow.state.get()).toMatchObject({ failed: false, capped: false })
    expect(modals).toEqual([])
  })

  it("starts no derivation once the screen has gone", async () => {
    const { source, pending } = fakeSource()
    const { flow, screen } = open(source)
    screen.abort()
    expect(await flow.handOut()).toBe(false)
    expect(pending).toHaveLength(0)
  })

  it("ends a derivation waiting for the keys with the screen, and reports nothing", async () => {
    const { source } = fakeSource()
    const { flow, screen } = open(source)
    const ask = flow.handOut()
    screen.abort()
    expect(await ask).toBe(false)
    expect(flow.state.get()).toMatchObject({ failed: false, capped: false, running: undefined })
    expect(modals).toEqual([])
  })
})

describe("the fake address source", () => {
  /** The real source over an empty store, with the account's keys never ready. */
  async function realSource(): Promise<Source> {
    const keys = service<[], SipaKeys>(
      "sipaKeys",
      { from: [], retry: "manual" },
      () => new Promise<never>(() => {}),
    )
    return createSipaAddresses({
      page: { config: defaultConfig, chain: { oxideTuple: answered(TUPLE) } } as never,
      store: createSipaDeposits({
        db: openDatabase(memoryBackend()),
        account: true,
        now: () => Date.now(),
      }),
      wallet: fixed("wallet", {} as never),
      keys,
      discovery: () => fixed("discovery", {} as never),
      identity: memoryStore({
        value: { handle: "alice", address: ACCOUNT, claimedAt: 1 },
        loaded: true,
        failed: false,
      }).readonly,
      railPending: memoryStore({ status: "pending" } as const).readonly,
      wakeBroadcasts: () => {},
      wake: async () => {},
    })
  }

  for (const [name, make] of [
    ["fake", async () => fakeSource().source],
    ["real", realSource],
  ] as const) {
    it(`${name}: refuses a pool read on an empty pool`, async () => {
      const source = await make()
      await expect(source.depositAddress("alice", { publishingLimit: 0 })).rejects.toBeInstanceOf(
        AddressesPublishingError,
      )
    })

    it(`${name}: a derivation waiting for the keys ends with its signal`, async () => {
      const source = await make()
      const screen = new AbortController()
      const derived = source.depositAddress("alice", { publishingLimit: 2, signal: screen.signal })
      screen.abort()
      await expect(derived).rejects.toThrow()
    })
  }
})
