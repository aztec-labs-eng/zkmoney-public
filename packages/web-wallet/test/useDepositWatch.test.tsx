import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Address } from "viem"
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
    const value = useDepositWatch(config, address ? { token, address } : null)
    return <span>{String(value)}</span>
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
