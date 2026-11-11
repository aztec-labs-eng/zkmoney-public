/** Which self-derived addresses a view may take, and which slot the next derivation uses. */
import { describe, expect, it, vi } from "vitest"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createSipaDeposits,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  SELF_SLOTS,
  type IdentityView,
  type SipaDeposit,
} from "@obsidion/front-core"
import { AddressesPublishingError } from "../../../../src/features/deposit/addressesPublishing"
import {
  createSipaAddresses,
  inSipaPool,
  nextSipaSlot,
  sipaPoolDeployment,
  unpublishedSlots,
} from "../../../../src/features/deposit/sipaAddresses"
import { defaultConfig } from "../../../support/page"
import { answered } from "../../../support/query"

const MAX_NONCE = 1_000_000
const nonceOf = (slot: number) => MAX_NONCE - 1 - slot
const USER = "0x0a"
const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
} as OxideEnvTuple

const record = (over: Partial<SipaDeposit> = {}): SipaDeposit =>
  ({
    sipaAddress: "0x00000000000000000000000000000000000000c1",
    recipientL2Address: USER,
    phase: "resolved",
    amount: "0",
    ...over,
  } as SipaDeposit)

describe("nextSipaSlot", () => {
  it("takes the slot past the highest one this account recorded today, or the chain floor", () => {
    const records = [
      record({ slot: { day: 5, nonce: nonceOf(2) } }),
      record({ slot: { day: 5, nonce: nonceOf(0) } }),
      record({ slot: { day: 4, nonce: nonceOf(9) } }),
      record({ recipientL2Address: "0x0b", slot: { day: 5, nonce: nonceOf(7) } }),
    ]
    expect(nextSipaSlot(records, USER, 5, 0)).toBe(3)
    expect(nextSipaSlot(records, USER, 5, 6)).toBe(6)
    expect(nextSipaSlot(records, USER, 6, 0)).toBe(0)
  })
})

describe("inSipaPool", () => {
  const pooled = (over: Partial<SipaDeposit> = {}) =>
    record({
      slot: { day: 10, nonce: 1, deployment: sipaPoolDeployment(TUPLE) },
      broadcast: {
        kind: "pool",
        source: { type: "slot" },
        state: "landed",
        createdAt: 1,
        failures: 0,
      },
      ...over,
    })

  it("holds an unshown pool broadcast of this account and deployment, newer than the oldest day", () => {
    expect(inSipaPool(pooled(), USER, TUPLE, 9)).toBe(true)
    expect(inSipaPool(pooled(), USER, TUPLE, 10)).toBe(false)
    expect(inSipaPool(pooled(), "0x0b", TUPLE, 9)).toBe(false)
    expect(
      inSipaPool(pooled({ slot: { day: 10, nonce: 1, deployment: "1:0x1" } }), USER, TUPLE, 9),
    ).toBe(false)
    const shown = pooled().broadcast!
    expect(
      inSipaPool(pooled({ broadcast: { ...shown, kind: "deposit", shownAt: 2 } }), USER, TUPLE, 9),
    ).toBe(false)
  })
})

describe("the unpublished slot cap", () => {
  const today = Math.floor(Date.now() / 86_400_000)
  /** An own slot shown and paid whose broadcast has not landed: no publishing limit counts it. */
  const unpublished = (n: number, over: Partial<SipaDeposit> = {}) =>
    record({
      sipaAddress: `0x${n.toString(16).padStart(40, "0")}`,
      networkId: "0xnet",
      l1ChainId: 31337,
      slot: { day: today, nonce: nonceOf(n) },
      broadcast: {
        kind: "deposit",
        source: { type: "slot" },
        state: "queued",
        createdAt: 1,
        fundedAt: 2,
        failures: 0,
      },
      ...over,
    })

  it("counts this account's slots of the window's days whose broadcast has not landed", () => {
    const landed = unpublished(1).broadcast!
    const records = [
      unpublished(1),
      unpublished(2, { broadcast: { ...landed, state: "landed" } }),
      unpublished(3, { recipientL2Address: "0x0b" }),
      unpublished(4, { slot: { day: today - 24, nonce: nonceOf(4) } }),
      unpublished(5, { slot: { day: today - 23, nonce: nonceOf(5) } }),
      // An ETH-only own slot, or an abandoned pool fill, owes nothing.
      unpublished(6, { broadcast: undefined }),
    ]
    expect(unpublishedSlots(records, USER, Date.now())).toBe(2)
  })

  it(`refuses a new address while ${SELF_SLOTS.lookahead} slots are unpublished`, async () => {
    const store = createSipaDeposits({
      db: openDatabase(memoryBackend()),
      account: true,
      now: () => Date.now(),
    })
    // The derivation's first L2 read: past the cap, the derivation is under way.
    const getBlock = vi.fn(() => new Promise<never>(() => {}))
    const addresses = createSipaAddresses({
      page: { config: defaultConfig, chain: { oxideTuple: answered(TUPLE) } } as never,
      store,
      wallet: fixed("wallet", { node: { getBlock } } as never),
      keys: fixed("keys", { recipient: { toString: () => USER } } as never),
      discovery: () => fixed("discovery", {} as never),
      identity: memoryStore<IdentityView>({ value: null, loaded: true, failed: false }).readonly,
      railPending: memoryStore({ status: "pending" } as const).readonly,
      wakeBroadcasts: () => {},
      wake: async () => {},
    })
    for (let n = 1; n <= SELF_SLOTS.lookahead; n++) {
      const { sipaAddress, slot } = unpublished(n)
      const fields = { ...record({ sipaAddress, slot }), networkId: "0xnet", l1ChainId: 31337 }
      await store.apply(sipaAddress, { type: "derived", fields })
      await store.oweBroadcast(sipaAddress, {
        kind: "deposit",
        source: { type: "slot" },
        fundedAt: 2,
      })
    }
    await expect(addresses.depositAddress("alice")).rejects.toBeInstanceOf(AddressesPublishingError)
    expect(getBlock).not.toHaveBeenCalled()

    await store.apply(unpublished(1).sipaAddress, { type: "broadcastLanded" })
    void addresses.depositAddress("alice")
    await vi.waitFor(() => expect(getBlock).toHaveBeenCalledOnce())
  })
})
