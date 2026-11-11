// @vitest-environment node
/** A deposit address hand-out: a pooled address first, else a fresh derivation within its limit. */
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  createSipaDeposits,
  encodeRecord,
  fixed,
  memoryBackend,
  memoryStore,
  openDatabase,
  type SipaBroadcast,
  type SipaDeposit,
} from "@obsidion/front-core"
import { AddressesPublishingError } from "../../../src/features/deposit/addressesPublishing"
import {
  createSipaAddresses,
  sipaPoolDeployment,
} from "../../../src/features/deposit/sipaAddresses"
import { defaultConfig, testPage } from "../../support/page"

const NODE_DOWN = new Error("node down")

const ACCOUNT = `0x${"a1".repeat(32)}`
const TUPLE = {
  rollupVersion: "7",
  portal: "0x00000000000000000000000000000000000000a0",
  forwardingTable: "0x00000000000000000000000000000000000000fb",
} as OxideEnvTuple

const record = (address: string, broadcast: SipaBroadcast): SipaDeposit => ({
  sipaAddress: address as Address,
  recipientL2Address: ACCOUNT,
  messageSecret: "0x1",
  recipientHash: "0x2",
  recoveryAddress: "",
  l1ChainId: 31337,
  networkId: "0xnet",
  amount: "0",
  tokenSymbol: "DAI",
  phase: "broadcast",
  startTime: 1,
  slot: {
    day: Math.floor(Date.now() / 86_400_000),
    nonce: 1,
    deployment: sipaPoolDeployment(TUPLE),
  },
  broadcast,
})

const pooled = (address: string, state: SipaBroadcast["state"]) =>
  record(address, { kind: "pool", source: { type: "slot" }, state, createdAt: 1, failures: 0 })

const shown = (address: string) =>
  record(address, {
    kind: "deposit",
    source: { type: "slot" },
    state: "queued",
    createdAt: 1,
    shownAt: 1,
    failures: 0,
  })

/** The account's addresses over `records`; the first L2 read of a derivation fails. */
async function addressesOver(records: SipaDeposit[], tuple: OxideEnvTuple = TUPLE) {
  const backend = memoryBackend()
  // Saved by this version: no migration runs over it.
  await backend.apply([
    ...records.map((r): [string, string] => [
      `acct/sipaDeposits/${r.sipaAddress}`,
      encodeRecord(r),
    ]),
    ["acct/meta/sipaDeposits", "3"],
  ])
  const store = createSipaDeposits({
    db: openDatabase(backend),
    account: true,
    now: () => Date.now(),
  })
  const getBlock = vi.fn(async () => {
    throw NODE_DOWN
  })
  const wake = vi.fn(async () => {})
  const addresses = createSipaAddresses({
    page: testPage(undefined, defaultConfig, { tuple }),
    store,
    wallet: fixed("wallet", { node: { getBlock }, networkId: "0xnet" } as never),
    keys: fixed("keys", { recipient: { toString: () => ACCOUNT } } as never),
    discovery: () => fixed("discovery", {} as never),
    identity: memoryStore({
      value: { handle: "alice", address: ACCOUNT, claimedAt: 1 },
      loaded: true,
      failed: false,
    }).readonly,
    railPending: memoryStore({ status: "pending" } as const).readonly,
    wakeBroadcasts: () => {},
    wake,
  })
  return { addresses, getBlock, wake }
}

afterEach(() => vi.restoreAllMocks())

describe("depositAddress", () => {
  it("hands out a landed pooled address under the deployment's ENS name, and wakes the pool", async () => {
    const address = "0x00000000000000000000000000000000000000c1"
    const { addresses, getBlock, wake } = await addressesOver([pooled(address, "landed")], {
      ...TUPLE,
      ensDomain: "oxide.eth",
    })

    const handed = await addresses.depositAddress("alice")

    expect(handed).toEqual({
      address: "0x00000000000000000000000000000000000000C1",
      name: "alice.oxide.eth",
      source: "pool",
    })
    expect(wake).toHaveBeenCalledWith(addresses.pool)
    expect(getBlock).not.toHaveBeenCalled()
  })

  it("hands out a pool fill still proving, with the publish it waits on", async () => {
    const address = "0x00000000000000000000000000000000000000c2"
    const { addresses, getBlock } = await addressesOver([pooled(address, "proving")])

    const handed = await addresses.depositAddress("alice")

    expect(handed).toMatchObject({ name: "alice", source: "filling" })
    expect(handed.address.toLowerCase()).toBe(address)
    expect(handed.publish).toBeTypeOf("function")
    expect(getBlock).not.toHaveBeenCalled()
  })

  it("refuses a fresh derivation while the publishing limit is reached", async () => {
    const { addresses, getBlock } = await addressesOver([
      shown("0x00000000000000000000000000000000000000d1"),
      shown("0x00000000000000000000000000000000000000d2"),
    ])

    await expect(addresses.depositAddress("alice", { publishingLimit: 2 })).rejects.toBeInstanceOf(
      AddressesPublishingError,
    )
    expect(getBlock).not.toHaveBeenCalled()
  })

  it("derives a fresh address below the limit, and reports the derivation's failure", async () => {
    const { addresses, getBlock } = await addressesOver([
      shown("0x00000000000000000000000000000000000000d3"),
    ])
    const onStage = vi.fn()

    await expect(addresses.depositAddress("alice", { publishingLimit: 2, onStage })).rejects.toBe(
      NODE_DOWN,
    )
    expect(onStage).toHaveBeenCalledWith("resolving")
    expect(getBlock).toHaveBeenCalledOnce()
  })
})
