// @vitest-environment node
/** The row a funding settles on, and what a deposit of a picked token credits. */
import { describe, expect, it } from "vitest"
import type { PinnedOxideDeployment } from "@obsidion/core/oxide"
import type { WebWalletConfig } from "../../../src/config/env"
import {
  depositCreditNote,
  recordedRowToken,
  settlementDecimals,
  settlementSymbol,
  settlementToken,
} from "../../../src/features/sipa/loadDepositFacts"
import {
  MAINNET_DAI,
  MAINNET_USDC,
  ROW_DAI,
  ROW_USDC,
  mainnetTokens,
  twoRowTokens,
} from "../../support/depositTokens"

const UNLISTED = `0x${"99".repeat(20)}`

describe("depositCreditNote", () => {
  it("names the settlement token for a swapped token, and only the token itself otherwise", () => {
    const tokens = mainnetTokens()
    const [dai, usdc] = tokens.options
    const swapped = depositCreditNote(usdc!, tokens.settlement)
    const own = depositCreditNote(dai!, tokens.settlement)

    expect(swapped).toContain("USDC")
    expect(swapped).toContain("DAI")
    expect(own).toContain("DAI")
    expect(own).not.toContain("USDC")
    expect(depositCreditNote(dai!, usdc!)).toBe(own)
  })
})

describe("settlementSymbol", () => {
  it("is the row token's symbol for a swapped token, and the token's own on its row", () => {
    expect(settlementSymbol(mainnetTokens(), MAINNET_USDC.toLowerCase(), "?")).toBe("DAI")
    expect(settlementSymbol(twoRowTokens(), ROW_USDC, "?")).toBe("USDC")
  })

  it("is the fallback until the tokens are read, without a token, or for one the table omits", () => {
    expect(settlementSymbol(undefined, ROW_USDC, "?")).toBe("?")
    expect(settlementSymbol(twoRowTokens(), undefined, "?")).toBe("?")
    expect(settlementSymbol(twoRowTokens(), UNLISTED, "?")).toBe("?")
  })
})

describe("settlementToken", () => {
  it("is the row token a listed token settles on", () => {
    expect(settlementToken(mainnetTokens(), MAINNET_USDC)).toBe(MAINNET_DAI)
    expect(settlementToken(twoRowTokens(), ROW_USDC.toUpperCase())).toBe(ROW_USDC)
  })

  it("is the default pick's row for a record with no token", () => {
    expect(settlementToken(twoRowTokens("USDC"), undefined)).toBe(ROW_USDC)
  })

  it("is undefined until the tokens are read, or for a token the table omits", () => {
    expect(settlementToken(undefined, ROW_DAI)).toBeUndefined()
    expect(settlementToken(undefined, undefined)).toBeUndefined()
    expect(settlementToken(twoRowTokens(), UNLISTED)).toBeUndefined()
  })
})

describe("recordedRowToken", () => {
  const FEE_TOKEN = `0x${"fe".repeat(20)}`
  const mainnet = { l1ChainId: 1 } as WebWalletConfig
  const pinned = {
    deployment: { feeToken: FEE_TOKEN },
    pinned: { underlying: MAINNET_DAI },
  } as unknown as PinnedOxideDeployment
  const row = (intent: "deposit" | "registration", token?: string) =>
    recordedRowToken(mainnet, pinned, intent, token).toLowerCase()

  it("is the row a swapped token settles on, as the deposit-token list names it", () => {
    expect(row("deposit", MAINNET_USDC)).toBe(MAINNET_DAI.toLowerCase())
    expect(row("deposit", MAINNET_USDC)).toBe(
      settlementToken(mainnetTokens(), MAINNET_USDC)!.toLowerCase(),
    )
  })

  it("is the token's own row for a deposit, and the fee token's row for every other intent", () => {
    expect(row("deposit", MAINNET_DAI)).toBe(MAINNET_DAI.toLowerCase())
    expect(row("registration", MAINNET_USDC)).toBe(FEE_TOKEN)
  })

  it("is the pinned bridge's row for a record with no token", () => {
    expect(row("deposit")).toBe(MAINNET_DAI.toLowerCase())
  })
})

describe("settlementDecimals", () => {
  it("is the settlement row's decimals, not the funded token's", () => {
    expect(settlementDecimals(mainnetTokens(), MAINNET_USDC)).toBe(18)
    expect(settlementDecimals(twoRowTokens(), ROW_USDC)).toBe(6)
  })

  it("is the default pick's row for a record with no token", () => {
    expect(settlementDecimals(twoRowTokens("USDC"), undefined)).toBe(6)
  })

  it("is undefined until the tokens are read, or for a token the table omits", () => {
    expect(settlementDecimals(undefined, ROW_DAI)).toBeUndefined()
    expect(settlementDecimals(twoRowTokens(), UNLISTED)).toBeUndefined()
  })
})
