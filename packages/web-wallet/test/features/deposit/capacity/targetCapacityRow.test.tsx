import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Address } from "viem"
import type { SipaDeposit } from "@obsidion/front-core"
import { tokenOption } from "../../../support/depositTokens"

const h = vi.hoisted(() => ({ terms: vi.fn() }))

const DAI = `0x${"da".repeat(20)}` as Address
const SUSDS = `0x${"5d".repeat(20)}` as Address
const TABLE = `0x${"fb".repeat(20)}` as Address
const SIPA = `0x${"ab".repeat(20)}` as Address

vi.mock("@obsidion/sdk", async (original) => ({
  ...(await original<object>()),
  readSipaPortalTerms: h.terms,
}))
vi.mock("../../../../src/config/env", async (original) => ({
  ...(await original<object>()),
  getConfig: () => ({ l1ChainId: 31337 }),
}))
vi.mock("../../../../src/config/oxideTuple", async (original) => ({
  ...(await original<object>()),
  l1PublicClient: () => ({}),
}))
vi.mock("../../../../src/features/sipa/loadDepositFacts", async (importOriginal) => {
  const { mockLoadDepositFacts } = await import("../../../support/depositTokens")
  const dai = tokenOption("DAI", DAI)
  return mockLoadDepositFacts(importOriginal, () => ({
    options: [dai, tokenOption("sUSDS", SUSDS)],
    offered: [dai],
    settlement: dai,
  }))
})
vi.mock("../../../../src/features/deposit/capacityStore", () => ({
  activeCapacityKey: async () => undefined,
  depositCapacityStore: () => ({
    subscribe: () => () => {},
    getState: () => undefined,
    retry: async () => {},
    policy: { staleAfterMs: 1 },
  }),
}))

const { useTargetCapacity } = await import("../../../../src/features/deposit/targetCapacity")
const { closeSession } = await import("../../../../src/session/session")
const { openTestSession } = await import("../../../support/session")
const { seedSipaDeposit } = await import("../../../support/sipaDeposits")

function recorded(tokenAddress?: Address): SipaDeposit {
  return {
    sipaAddress: SIPA,
    phase: "sweeping",
    l1ChainId: 31337,
    tokenAddress,
    networkId: "0xnet",
    origin: { protocol: "account", forwardingTable: TABLE },
  } as unknown as SipaDeposit & { networkId: string }
}

let root: Root
let seen: ReturnType<typeof useTargetCapacity> | undefined

function Probe() {
  seen = useTargetCapacity({ kind: "recorded", sipaAddress: SIPA })
  return null
}

beforeEach(() => {
  seen = undefined
  h.terms.mockReset()
  h.terms.mockImplementation(async (_client: unknown, route: { token: Address }) => ({
    portal: route.token === SUSDS ? `0x${"55".repeat(20)}` : `0x${"dd".repeat(20)}`,
    token: route.token,
    txAmountCap: 1n,
    depositFee: 0n,
  }))
  root = createRoot(document.createElement("div"))
  openTestSession()
})

afterEach(async () => {
  await act(async () => root.unmount())
  closeSession()
})

describe("useTargetCapacity for a recorded deposit", () => {
  it("reads the terms of the row its funds are in", async () => {
    await seedSipaDeposit({ ...recorded(SUSDS), networkId: "0xnet" })
    await act(async () => root.render(<Probe />))
    await vi.waitFor(() => expect(seen?.terms).toBeDefined())
    expect(h.terms).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ token: SUSDS }),
    )
    expect(seen?.terms?.token).toBe(SUSDS)
  })

  it("reads the intent's settlement row while no token is recorded", async () => {
    await seedSipaDeposit({ ...recorded(undefined), networkId: "0xnet" })
    await act(async () => root.render(<Probe />))
    await vi.waitFor(() => expect(h.terms).toHaveBeenCalled())
    expect(h.terms).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ token: DAI }))
  })
})
