import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Address } from "viem"
import { Network } from "@obsidion/sdk"
import type { WebWalletConfig } from "../src/config/env"
const { readContract } = vi.hoisted(() => ({ readContract: vi.fn() }))
vi.mock("../src/config/oxideTuple", () => ({ l1PublicClient: () => ({ readContract }) }))
import { useDepositWatch } from "../src/features/onboarding/useDepositWatch"

it("does not grant a new address the previously observed balance while its read is pending", async () => {
  const el = document.createElement("div")
  const root = createRoot(el)
  const config = {} as WebWalletConfig
  const token = "0x0000000000000000000000000000000000000001" as Address
  const first = "0x0000000000000000000000000000000000000002" as Address
  const second = "0x0000000000000000000000000000000000000003" as Address
  function View({ address }: { address?: Address }) {
    const { balance } = useDepositWatch(config, address ? { token, address } : null)
    return <span>{String(balance)}</span>
  }
  try {
    readContract.mockResolvedValueOnce(5n * 10n ** 18n)
    await act(async () => root.render(<View address={first} />))
    expect(el.textContent).toBe("5000000000000000000")
    readContract.mockImplementation(() => new Promise(() => {}))
    await act(async () => root.render(<View address={second} />))
    expect(el.textContent).toBe("0")
    await act(async () => root.render(<View />))
    expect(el.textContent).toBe("0")
  } finally {
    await act(async () => root.unmount())
  }
})

it("reads a USDC-funded address in the manifest token's units", async () => {
  const el = document.createElement("div")
  const root = createRoot(el)
  const config = { network: Network.MAINNET } as WebWalletConfig
  const token = "0x0000000000000000000000000000000000000001" as Address
  const address = "0x0000000000000000000000000000000000000002" as Address
  function View() {
    const { balance, token: held } = useDepositWatch(config, { token, address })
    return <span>{`${balance}:${held}`}</span>
  }
  try {
    readContract.mockReset()
    readContract.mockImplementation(async ({ address: erc20 }: { address: Address }) =>
      erc20.toLowerCase() === "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" ? 15_000_000n : 0n,
    )
    await act(async () => root.render(<View />))
    expect(el.textContent).toBe("15000000000000000000:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48")
  } finally {
    await act(async () => root.unmount())
  }
})

it("a read that lands after a newer one does not overwrite it", async () => {
  vi.useFakeTimers()
  const el = document.createElement("div")
  const root = createRoot(el)
  const config = {} as WebWalletConfig
  const token = "0x0000000000000000000000000000000000000001" as Address
  const address = "0x0000000000000000000000000000000000000002" as Address
  let read!: () => Promise<void>
  function View() {
    const watch = useDepositWatch(config, { token, address })
    read = watch.read
    return <span>{String(watch.balance)}</span>
  }
  try {
    readContract.mockReset()
    readContract.mockResolvedValueOnce(0n)
    await act(async () => root.render(<View />))
    expect(el.textContent).toBe("0")
    // The poll's read goes out and stalls; a manual read started after it lands first.
    let landPoll!: (balance: bigint) => void
    readContract.mockImplementationOnce(() => new Promise((resolve) => (landPoll = resolve)))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    readContract.mockResolvedValueOnce(5n * 10n ** 18n)
    await act(async () => read())
    expect(el.textContent).toBe("5000000000000000000")
    await act(async () => {
      landPoll(0n)
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(el.textContent).toBe("5000000000000000000")
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
  }
})

it("stamps when each read landed, and keeps the last stamp through a failed one", async () => {
  vi.useFakeTimers()
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  const el = document.createElement("div")
  const root = createRoot(el)
  const config = {} as WebWalletConfig
  const token = "0x0000000000000000000000000000000000000001" as Address
  const address = "0x0000000000000000000000000000000000000002" as Address
  function View() {
    const { readAt } = useDepositWatch(config, { token, address })
    return <span>{String(readAt)}</span>
  }
  try {
    readContract.mockReset()
    readContract.mockResolvedValue(0n)
    await act(async () => root.render(<View />))
    const first = Number(el.textContent)
    expect(first).toBe(Date.now())
    readContract.mockRejectedValueOnce(new Error("HTTP request failed."))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(Number(el.textContent)).toBe(first)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })
    expect(Number(el.textContent)).toBe(first + 10_000)
  } finally {
    await act(async () => root.unmount())
    vi.useRealTimers()
    warn.mockRestore()
  }
})
