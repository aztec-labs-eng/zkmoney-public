import { describe, expect, it, vi } from "vitest"
import { ContractFunctionExecutionError, UnknownRpcError } from "viem"

vi.mock("wagmi/actions", () => ({ getAccount: () => ({}), switchChain: vi.fn() }))
vi.mock("../../../../src/session/wagmi", () => ({ wagmiConfig: () => ({}) }))

const { isWalletDisconnect } = await import("../../../../src/session/l1Wallet")

describe("isWalletDisconnect", () => {
  it("sees a wallet session that ended while a request waited", () => {
    const ended = Object.assign(new Error("User disconnected."), { code: 6000 })
    const transfer = { abi: [], functionName: "transfer" }
    for (const err of [
      new ContractFunctionExecutionError(new UnknownRpcError(ended), transfer),
      new UnknownRpcError(new Error("User disconnected.")),
      { message: "User disconnected." },
      { code: 4900, message: "Disconnected" },
    ])
      expect(isWalletDisconnect(err)).toBe(true)
  })

  it("ignores rejections, a chain-only disconnect and other errors", () => {
    for (const err of [
      { code: 4001, message: "User rejected the request." },
      { code: 4901, message: "Disconnected" },
      new UnknownRpcError(new Error("Internal JSON-RPC error.")),
      new Error("User disconnected. Reconnect to continue."),
      undefined,
    ])
      expect(isWalletDisconnect(err)).toBe(false)
  })
})
