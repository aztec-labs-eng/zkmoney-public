/**
 * Accepted-token fixtures for tests that mock `features/deposit/loadDepositFacts`: the mainnet shape (the DAI row and
 * the USDC and USDT that swap into it) and a one-row table. `mockLoadDepositFacts` keeps the module's pure helpers and
 * answers its table reads from a fixture.
 */
import type { Address } from "viem"
import type {
  DepositDisplayFacts,
  DepositTokenOption,
  DepositTokens,
} from "../../src/features/deposit/loadDepositFacts"

export const MAINNET_DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address
export const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address
export const MAINNET_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address

export function tokenOption(
  symbol: string,
  address: Address,
  decimals = 18,
  settlesIn: Address = address,
): DepositTokenOption {
  return {
    symbol,
    address,
    decimals,
    icon: `${symbol.toLowerCase()}.svg`,
    settlesIn,
    swapped: settlesIn.toLowerCase() !== address.toLowerCase(),
  }
}

/** The DAI row and the mainnet stablecoins its SIPA swaps into DAI; `dai` stands in for its address. */
export function mainnetTokens(dai: Address = MAINNET_DAI): DepositTokens {
  const settlement = tokenOption("DAI", dai)
  const options = [
    settlement,
    tokenOption("USDC", MAINNET_USDC, 6, dai),
    tokenOption("USDT", MAINNET_USDT, 6, dai),
  ]
  return { options, offered: options, settlement }
}

export const ROW_DAI = "0x00000000000000000000000000000000000000da" as Address
export const ROW_USDC = "0x00000000000000000000000000000000000000c6" as Address

/**
 * A two-row table off mainnet: DAI and USDC each settle on their own row, so neither swaps. `settles` is the default
 * pick: the pinned bridge's token for a deposit, the fee token for a registration.
 */
export function twoRowTokens(settles: "DAI" | "USDC" = "DAI"): DepositTokens {
  const dai = tokenOption("DAI", ROW_DAI)
  const usdc = tokenOption("USDC", ROW_USDC, 6)
  return { options: [dai, usdc], offered: [dai, usdc], settlement: settles === "DAI" ? dai : usdc }
}

export const ROW_SUSDS = "0x000000000000000000000000000000000000005d" as Address

/** A Sky table: Main's DAI row and the sUSDS row Savings binds, which a SIPA accepts but no deposit surface offers. */
export function savingsRowTokens(): DepositTokens {
  const dai = tokenOption("DAI", ROW_DAI)
  return { options: [tokenOption("sUSDS", ROW_SUSDS), dai], offered: [dai], settlement: dai }
}

/** A Sky table whose profile pins the sUSDS row, so the default pick is one Main does not offer; `offered` as given. */
export function pinnedSavingsRowTokens(offersDai = true): DepositTokens {
  const susds = tokenOption("sUSDS", ROW_SUSDS)
  const dai = tokenOption("DAI", ROW_DAI)
  return { options: [susds, dai], offered: offersDai ? [dai] : [], settlement: susds }
}

/** A registration on a two-row table whose fee token is USDC: only the fee token's row is listed. */
export function usdcFeeTokens(): DepositTokens {
  const usdc = tokenOption("USDC", ROW_USDC, 6)
  return { options: [usdc], offered: [usdc], settlement: usdc }
}

/** A one-row table of `token`. */
export function singleToken(token: Address, symbol = "DAI", decimals = 18): DepositTokens {
  const settlement = tokenOption(symbol, token, decimals)
  return { options: [settlement], offered: [settlement], settlement }
}

/**
 * A `vi.mock` factory body for `loadDepositFacts`: the real pure helpers, with the table reads answered from
 * `tokens()` and `facts()`. Use as `vi.mock(path, (importOriginal) => mockLoadDepositFacts(importOriginal, () => t))`.
 */
export async function mockLoadDepositFacts(
  importOriginal: () => Promise<unknown>,
  tokens: () => DepositTokens | undefined,
  facts?: () => Promise<DepositDisplayFacts>,
  /** Whether the last read failed, and what Retry does; a read never fails unless given. */
  read?: () => { failed: boolean; retry: () => void },
) {
  const actual =
    (await importOriginal()) as typeof import("../../src/features/deposit/loadDepositFacts")
  const loaded = async () => {
    const value = tokens()
    if (!value) throw new Error("no accepted tokens in this test")
    return value
  }
  return {
    ...actual,
    useDepositTokens: () => tokens(),
    useDepositTokensRead: () => ({
      tokens: tokens(),
      failed: false,
      retry: () => {},
      ...read?.(),
    }),
    loadDepositTokens: loaded,
    sipaFundingTokens: async (
      _config: unknown,
      head: Address | { address: Address; symbol: string; decimals: number },
    ) => {
      const value = await loaded()
      if (typeof head !== "string") return actual.fundingTokensFrom(value, head)
      const listed = value.options.find((t) => t.address.toLowerCase() === head.toLowerCase())
      return actual.fundingTokensFrom(value, {
        address: head,
        symbol: listed?.symbol ?? "",
        decimals: listed?.decimals ?? 18,
      })
    },
    recoveryProbeTokens: async (_config: unknown, head: Address) => {
      const value = await loaded()
      const listed = value.options.find((t) => t.address.toLowerCase() === head.toLowerCase())
      return actual.fundingTokensFrom(value, {
        address: head,
        symbol: listed?.symbol ?? "",
        decimals: listed?.decimals ?? 18,
      })
    },
    tokenMetadata: async (_config: unknown, token: Address) => {
      const listed = tokens()?.options.find((t) => t.address.toLowerCase() === token.toLowerCase())
      return { symbol: listed?.symbol ?? "", decimals: listed?.decimals ?? 18 }
    },
    ...(facts ? { loadDepositDisplayFacts: facts } : {}),
  }
}
