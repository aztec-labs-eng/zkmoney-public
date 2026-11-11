import { describe, expect, it } from "vitest"
import { formatTransactionReceipt, getAddress, toEventSelector, type Address, type Hex } from "viem"
import receiptFixture from "../../fixtures/across/fillReceipt.json"
import { acrossFillIn, FILLED_RELAY } from "../../../src/core/services/crossChain/acrossFill"

// A mainnet SpokePool transaction that filled two deposits. In the second, the handler sent USDT
// back to the depositor instead of swapping.
const receipt = formatTransactionReceipt(receiptFixture as never)
const PAID = "0xb28247e84ce3fbeb6e74cb006978a52bb73e0ac6" as Address
const HANDLER = "0x0f7ae28de1c8532170ad4ee566b5801485c13a0e" as Address
const FILLED_RELAY_TOPIC = "0x44b559f101f8fbcc8a0ea43fa91a05a729a5ea6e14a7c75aa750374690137208"

describe("acrossFillIn", () => {
  it("names the event Across's SpokePool emits", () => {
    expect(toEventSelector(FILLED_RELAY)).toBe(FILLED_RELAY_TOPIC)
    expect(receipt.logs.filter((l) => l.topics[0] === FILLED_RELAY_TOPIC)).toHaveLength(2)
  })

  it("reads the fill just before the transfer that paid the address", () => {
    expect(acrossFillIn(receipt.logs, PAID)).toEqual({
      originChainId: 56,
      depositId: "1271856",
      depositor: getAddress(PAID),
      inputToken: "0x55d398326f99059fF775485246999027B3197955",
      inputAmount: 9_931_000_000_000_000_000n,
      token: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      value: 9_897_817n,
    })
  })

  it("takes the nearest fill, whatever order the logs come in", () => {
    const shuffled = [...receipt.logs].reverse()
    expect(acrossFillIn(shuffled, PAID)?.depositId).toBe("1271856")
    // The handler took WETH right after the first fill.
    expect(acrossFillIn(receipt.logs, HANDLER)?.depositId).toBe("1271854")
  })

  it("finds none for an address no transfer paid, or a transfer no fill came before", () => {
    expect(acrossFillIn(receipt.logs, `0x${"e9".repeat(20)}`)).toBeUndefined()
    const unfilled = receipt.logs.filter((l) => l.topics[0] !== FILLED_RELAY_TOPIC)
    expect(acrossFillIn(unfilled, PAID)).toBeUndefined()
    expect(acrossFillIn([], PAID as Hex)).toBeUndefined()
  })
})
