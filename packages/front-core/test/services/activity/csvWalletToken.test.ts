import { describe, expect, it } from "vitest"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import { csvWalletToken } from "../../../src/core/services/activity/activityCsv"

describe("the token the exports report in", () => {
  const rows = [
    { address: "0xOld", symbol: "USDC", decimals: 6 },
    { address: "0xMain", symbol: "USDC", decimals: 18 },
  ]

  it("waits for the active row's decimals to be checked, not for a live balance", () => {
    expect(csvWalletToken(rows, "0xmain", false)).toBeUndefined()
    expect(csvWalletToken(rows, undefined, true)).toBeUndefined()
    expect(csvWalletToken(rows, "0xmain", true)).toEqual({
      symbol: WALLET_TOKEN_SYMBOL,
      decimals: 18,
    })
  })

  it("names the wallet token, never a legacy row's symbol", () => {
    expect(csvWalletToken(rows, "0xOLD", true)?.symbol).toBe(WALLET_TOKEN_SYMBOL)
    expect(WALLET_TOKEN_SYMBOL).not.toBe("USDC")
  })
})
