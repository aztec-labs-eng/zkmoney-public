/**
 * The ether.fi verdict: the factory's top-up registry on Ethereum mainnet (the wallet's own L1
 * client on mainnet, a public mainnet RPC elsewhere) and its safe registry on Optimism, and a hook
 * that keeps the verdict pinned to the address still in the field.
 */
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import { Network } from "@obsidion/core/constants"

const h = vi.hoisted(() => ({
  readContract: vi.fn(),
  publicRead: vi.fn(),
  optimismRead: vi.fn(),
  network: "mainnet" as string,
  features: {},
}))

vi.mock("../../../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ readContract: h.readContract }),
}))
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: ({ chain }: { chain: { id: number } }) => ({
    readContract: chain.id === 10 ? h.optimismRead : h.publicRead,
  }),
}))

const { checkEtherfiAddress, ETHERFI_FACTORY, useEtherfiAddressVerdict } = await import(
  "../../../src/features/withdraw/etherfiCheck"
)
const { openTestSession } = await import("../../support/session")
const { closeSession } = await import("../../../src/session/session")

const TARGET = getAddress(`0x${"dd".repeat(20)}`)
const FACTORY = ETHERFI_FACTORY

describe("checkEtherfiAddress", () => {
  const reader = (answer: boolean | Error) => ({
    readContract:
      answer instanceof Error
        ? vi.fn().mockRejectedValue(answer)
        : vi.fn().mockResolvedValue(answer),
  })
  const check = (mainnet: boolean | Error, optimism: boolean | Error) =>
    checkEtherfiAddress(TARGET, {
      mainnet: reader(mainnet),
      optimism: reader(optimism),
      retryDelaysS: [],
    })
  const down = new Error("rpc down")

  it("asks the mainnet factory for a top-up contract and the Optimism factory for a safe", async () => {
    const mainnet = reader(false)
    const optimism = reader(false)
    await checkEtherfiAddress(TARGET, { mainnet, optimism })
    expect(mainnet.readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: FACTORY,
        functionName: "isTopUpContract",
        args: [TARGET],
      }),
    )
    expect(optimism.readContract).toHaveBeenCalledWith(
      expect.objectContaining({ address: FACTORY, functionName: "isEtherFiSafe", args: [TARGET] }),
    )
  })

  it.each([
    [true, false, "confirmed"],
    [true, down, "confirmed"],
    [false, true, "account"],
    [down, true, "account"],
    [false, false, "rejected"],
    [false, down, "unknown"],
    [down, false, "unknown"],
  ] as const)("mainnet %s, Optimism %s: %s", async (mainnet, optimism, kind) => {
    await expect(check(mainnet, optimism)).resolves.toEqual({ kind })
  })

  it("retries a failed read", async () => {
    const mainnet = { readContract: vi.fn().mockRejectedValueOnce(down).mockResolvedValue(true) }
    const verdict = checkEtherfiAddress(TARGET, {
      mainnet,
      optimism: reader(false),
      retryDelaysS: [0],
    })
    await expect(verdict).resolves.toEqual({ kind: "confirmed" })
    expect(mainnet.readContract).toHaveBeenCalledTimes(2)
  })
})

describe("useEtherfiAddressVerdict", () => {
  let container: HTMLDivElement
  let root: Root
  let renders: string[]
  const kind = () => container.textContent
  const Probe = ({ address, waitMs }: { address: typeof TARGET | null; waitMs?: number }) => {
    const verdict = useEtherfiAddressVerdict(address, waitMs).kind
    renders.push(verdict)
    return createElement("span", null, verdict)
  }
  const render = (address: typeof TARGET | null, waitMs?: number) =>
    act(async () => root.render(createElement(Probe, { address, waitMs })))
  const pass = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => {
    vi.useFakeTimers()
    h.network = Network.MAINNET
    openTestSession({ config: h as never })
    h.readContract.mockReset()
    h.publicRead.mockReset()
    h.optimismRead.mockReset().mockResolvedValue(false)
    renders = []
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    vi.useRealTimers()
    closeSession()
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

  it("never shows a new address the last one's verdict", async () => {
    h.readContract.mockResolvedValue(false)
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("rejected")
    renders = []
    await render(getAddress(`0x${"ee".repeat(20)}`))
    expect(renders[0]).toBe("checking")
  })

  it("reads unknown when the factory does not answer", async () => {
    h.readContract.mockRejectedValue(new Error("rpc down"))
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("checking")
    // Past the retries' backoff.
    await pass(1_500)
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

  it("confirms an Optimism safe whose mainnet top-up contract is not deployed", async () => {
    h.readContract.mockResolvedValue(false)
    h.optimismRead.mockResolvedValue(true)
    await render(TARGET)
    await pass(300)
    expect(kind()).toBe("account")
  })
})
