/**
 * The ether.fi verdict: one read of the top-up factory's registry on Ethereum mainnet, from the
 * wallet's own L1 client on mainnet and a public mainnet RPC elsewhere, and a hook that keeps the
 * verdict pinned to the address still in the field.
 */
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import { Network } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  publicRead: vi.fn(),
  network: "mainnet" as string,
}))

vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: h.network }) }))
vi.mock("../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ readContract: h.readContract }),
}))
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => ({ readContract: h.publicRead }),
}))

const {
  checkEtherfiAddress,
  ETHERFI_TOPUP_FACTORY,
  etherfiFactoryClient,
  useEtherfiAddressVerdict,
} = await import("../src/features/withdraw/etherfiCheck")

const TARGET = getAddress(`0x${"dd".repeat(20)}`)
const FACTORY = ETHERFI_TOPUP_FACTORY

describe("checkEtherfiAddress", () => {
  it("confirms an address the factory deployed, and asks the factory about that address", async () => {
    const readContract = vi.fn().mockResolvedValue(true)
    await expect(checkEtherfiAddress(TARGET, { client: { readContract } })).resolves.toEqual({
      kind: "confirmed",
    })
    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FACTORY,
        functionName: "isTopUpContract",
        args: [TARGET],
      }),
    )
  })

  it("rejects an address the factory did not deploy", async () => {
    const readContract = vi.fn().mockResolvedValue(false)
    await expect(checkEtherfiAddress(TARGET, { client: { readContract } })).resolves.toEqual({
      kind: "rejected",
    })
  })
})

describe("etherfiFactoryClient", () => {
  it("is the wallet's own L1 client on mainnet", () => {
    h.network = Network.MAINNET
    expect(etherfiFactoryClient().readContract).toBe(h.readContract)
  })

  it.each([Network.TESTNET, Network.SANDBOX])("is a public mainnet client on %s", (network) => {
    h.network = network
    expect(etherfiFactoryClient().readContract).toBe(h.publicRead)
  })
})

describe("useEtherfiAddressVerdict", () => {
  let container: HTMLDivElement
  let root: Root
  const kind = () => container.textContent
  const Probe = ({ address, waitMs }: { address: typeof TARGET | null; waitMs?: number }) =>
    createElement("span", null, useEtherfiAddressVerdict(address, waitMs).kind)
  const render = (address: typeof TARGET | null, waitMs?: number) =>
    act(async () => root.render(createElement(Probe, { address, waitMs })))
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.useFakeTimers()
    h.network = Network.MAINNET
    h.readContract.mockReset()
    h.publicRead.mockReset()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it("is idle with no address, checks through the debounce, then lands the read", async () => {
    h.readContract.mockResolvedValue(true)
    await render(null)
    expect(kind()).toBe("idle")
    await render(TARGET)
    expect(kind()).toBe("checking")
    expect(h.readContract).not.toHaveBeenCalled()
    await pass(300)
    expect(kind()).toBe("confirmed")
  })

  it("reads unknown when the factory does not answer", async () => {
    h.readContract.mockRejectedValue(new Error("rpc down"))
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("unknown")
  })

  it("reads unknown once the wait passes, then takes a late answer", async () => {
    let answer!: (value: boolean) => void
    h.readContract.mockReturnValue(new Promise<boolean>((resolve) => (answer = resolve)))
    await render(TARGET, 1_000)
    await pass(300)
    expect(kind()).toBe("checking")
    await pass(700)
    expect(kind()).toBe("unknown")
    await act(async () => answer(false))
    expect(kind()).toBe("rejected")
  })

  it("asks mainnet from a testnet build", async () => {
    h.network = Network.TESTNET
    h.publicRead.mockResolvedValue(false)
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("rejected")
    expect(h.readContract).not.toHaveBeenCalled()
  })
})
