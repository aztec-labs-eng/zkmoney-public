import { describe, expect, it } from "vitest"
import { isWalletConnectChainSwitchError } from "../src/errors/walletConnectError"

const bundle = "https://wallet.zk.money/assets/dist-BWU_haGN.js"
const v8Message = "Cannot read properties of undefined (reading 'request')"
const v8Stack = `TypeError: ${v8Message}\n    at e.request (${bundle}:11:159174)\n    at e.switchEthereumChain (${bundle}:11:173625)`
const geckoStack = `request@${bundle}:11:159174\nswitchEthereumChain@${bundle}:11:173625`

function typeError(message: string, stack: string): TypeError {
  const err = new TypeError(message)
  err.stack = stack
  return err
}

describe("isWalletConnectChainSwitchError", () => {
  it.each([
    [v8Message, v8Stack],
    [`can't access property "request", n is undefined`, geckoStack],
    ["undefined is not an object (evaluating 'this.getProvider(n).request')", geckoStack],
  ])("is true for %s under switchEthereumChain", (message, stack) => {
    expect(isWalletConnectChainSwitchError(typeError(message, stack))).toBe(true)
  })

  it.each([
    "Cannot read properties of undefined (reading 'toString')",
    "Cannot read properties of null (reading 'request')",
    "this.signer.request is not a function",
    "Cannot assign to read only property 'request' of object '#<Object>'",
  ])("is false for another TypeError under switchEthereumChain: %s", (message) => {
    expect(isWalletConnectChainSwitchError(typeError(message, v8Stack))).toBe(false)
  })

  it("is false for the same message without a switchEthereumChain frame", () => {
    const stack = `TypeError: ${v8Message}\n    at sendDeposit (${bundle}:3:100)`
    expect(isWalletConnectChainSwitchError(typeError(v8Message, stack))).toBe(false)
  })

  it("is false for a reason that is not a TypeError", () => {
    const err = new Error(v8Message)
    err.stack = v8Stack
    expect(isWalletConnectChainSwitchError(err)).toBe(false)
    expect(isWalletConnectChainSwitchError({ message: v8Message, stack: v8Stack })).toBe(false)
  })
})
