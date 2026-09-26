import { describe, expect, it, vi } from "vitest"
import { ContractFunctionExecutionError, UserRejectedRequestError } from "viem"

vi.mock("wagmi/actions", () => ({ getAccount: () => ({}), switchChain: vi.fn() }))
vi.mock("../src/features/deposit/wagmi", () => ({ wagmiConfig: () => ({}) }))

const { isWalletRejection } = await import("../src/features/deposit/l1Wallet")

describe("isWalletRejection", () => {
  it("sees a rejection wrapped by writeContract", () => {
    const inner = new UserRejectedRequestError(new Error("User denied transaction signature."))
    const wrapped = new ContractFunctionExecutionError(inner, { abi: [], functionName: "transfer" })
    expect(isWalletRejection(wrapped)).toBe(true)
  })

  it("sees a bare EIP-1193 4001", () => {
    expect(isWalletRejection({ code: 4001, message: "User rejected the request." })).toBe(true)
  })

  it("ignores other errors", () => {
    expect(isWalletRejection(new Error("insufficient funds"))).toBe(false)
    expect(isWalletRejection(undefined)).toBe(false)
  })
})
