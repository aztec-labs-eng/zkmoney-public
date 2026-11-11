import {
  BaseError,
  createPublicClient,
  erc20Abi,
  http,
  HttpRequestError,
  isAddressEqual,
  LimitExceededRpcError,
  parseUnits,
  TimeoutError,
  type Address,
  type Chain,
  type PublicClient,
  type Transport,
  formatUnits,
  zeroAddress,
} from "viem"
import {
  acrossFillIn,
  AcrossBridgeIn,
  WalletError,
  type AcrossContracts,
  type BridgeInDepositLookup,
  type BridgeInProvider,
  type BridgeInQuote,
  type BridgeInQuoteRequest,
  type FillReader,
  type OriginChain,
  type QueryFactory,
  type Service,
  type TokenDecimals,
  type UsdValuation,
} from "@obsidion/front-core"
import type { ConfigBridge, ConfigBridgeChain } from "@obsidion/config-client"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import { amountError, usdFigure } from "../../ui/format"
import { coinFigure } from "../../ui/coinDecimals"
import { groupedCents } from "../../ui/groupedCents"
import { bridgeChainFor, profileBridge } from "../../session/walletChains"
import type { DepositTokenOption } from "../sipa/loadDepositFacts"

export type OriginToken = ConfigBridgeChain["in"][number]

/** A chain a wallet can bridge in from, with the tokens it lists there. */
export interface BridgeRoute {
  chain: ConfigBridgeChain
  tokens: OriginToken[]
}

/** The token's contract; a chain's gas token is the zero address, as Across takes it. */
export const tokenAddress = (token: OriginToken): Address =>
  "address" in token ? (token.address as Address) : zeroAddress

export const isNativeToken = (address: Address) => isAddressEqual(address, zeroAddress)

/**
 * The chains a bridge-in can start from, in profile order: a chain lists the tokens that have a
 * landing in `coins`, its gas token among them, and needs one it can bridge now. `sameToken` keeps
 * the tokens that land as themselves, the only ones that can land an exact amount.
 */
export function bridgeRoutes(
  bridge: ConfigBridge,
  coins: DepositTokenOption[],
  { sameToken = false }: { sameToken?: boolean } = {},
): BridgeRoute[] {
  return bridge.chains
    .map((chain) => ({
      chain,
      tokens: chain.in.filter((t) => {
        const landing = bridgeLanding(coins, t.symbol)
        return landing && (!sameToken || landing.symbol === t.symbol)
      }),
    }))
    .filter((route) => route.tokens.some((t) => !t.comingSoon))
}

/**
 * A bridge-in's fee in dollars, decimal: the provider's price, else the quote's own rate into the
 * dollar coin it lands as. Amounts are base units; `outputDecimals` is the landing coin's.
 */
export function bridgeFeeUsd(
  bridged: { fee: bigint; inputAmount: bigint; outputAmount: bigint; feeUsd?: string },
  outputDecimals: number,
): string | undefined {
  return bridged.feeUsd ?? bridgeUsdValue(bridged, bridged.fee, outputDecimals)
}

/**
 * A dollar coin's bridge fee in dollars, decimal: what the wallet is `charged` less what lands, both
 * read 1:1 as dollars, so From less the fee is what lands.
 */
export function bridgeDollarFee(
  quote: Pick<BridgeInQuote, "outputAmount">,
  charged: bigint,
  inDecimals: number,
  outDecimals: number,
): string {
  const lost =
    parseUnits(formatUnits(charged, inDecimals), 18) -
    parseUnits(formatUnits(quote.outputAmount, outDecimals), 18)
  return formatUnits(lost > 0n ? lost : 0n, 18)
}

/** `atomic` of a bridge-in's origin coin in dollars, decimal, at the quote's own rate. */
export function bridgeUsdValue(
  bridged: { fee: bigint; inputAmount: bigint; outputAmount: bigint },
  atomic: bigint,
  outputDecimals: number,
): string | undefined {
  const sent = bridged.inputAmount - bridged.fee
  if (sent <= 0n) return undefined
  return formatUnits((atomic * bridged.outputAmount) / sent, outputDecimals)
}

/**
 * A bridge-in's origin coin priced at the quote's own rate into the landing coin, so the published
 * limit counts what is sent. Undefined without the landing's price or when the quote sends nothing.
 */
export function bridgeValuation(
  quote: Pick<BridgeInQuote, "fee" | "inputAmount" | "outputAmount">,
  landing: UsdValuation | undefined,
  inDecimals: number,
  outDecimals: number,
): UsdValuation | undefined {
  const sent = quote.inputAmount - quote.fee
  if (!landing || sent <= 0n || quote.outputAmount <= 0n) return undefined
  const { numerator, denominator } = landing.usdPerToken
  return {
    source: `bridge-quote:${landing.source}`,
    usdPerToken: {
      numerator: numerator * quote.outputAmount * 10n ** BigInt(inDecimals),
      denominator: denominator * sent * 10n ** BigInt(outDecimals),
    },
  }
}

/** The origin amount whose guaranteed minimum lands `landed` at `quote`'s rate, its fee on top. */
export function bridgeInputFor(
  quote: Pick<BridgeInQuote, "fee" | "inputAmount" | "outputAmount">,
  landed: bigint,
): bigint | undefined {
  const sent = quote.inputAmount - quote.fee
  if (sent <= 0n || quote.outputAmount <= 0n) return undefined
  return (landed * sent) / quote.outputAmount + quote.fee
}

/** What the review shows arriving: the typed To when the minimum covers it, else the minimum. */
export function bridgeReceived(minimum: bigint, typedTo: bigint | undefined): bigint {
  return typedTo !== undefined && minimum >= typedTo ? typedTo : minimum
}

/**
 * The deposit fee the sweep keeps from a bridge-in's landing, `depositFee` decimal in the landing
 * coin: what reaches the private funds for what lands, and what must land for `target` to.
 */
export function bridgeDepositFee(
  landing: { symbol: string; decimals: number },
  depositFee: string,
) {
  const fee = parseUnits(depositFee, landing.decimals)
  return {
    /** The fee in the landing coin's base units. */
    atomic: fee,
    arriving: (landed: bigint) => {
      const atomic = landed > fee ? landed - fee : 0n
      return {
        atomic,
        amount: groupedCents(formatUnits(atomic, landing.decimals)) ?? "0",
        symbol: landing.symbol,
      }
    },
    needed: (target: bigint) => target + fee,
  }
}

/** Decimal dollar amounts added, to 18 places. */
export const addDollars = (a: string, b: string) =>
  formatUnits(parseUnits(a, 18) + parseUnits(b, 18), 18)

/** The tokens Across carries as themselves; it swaps any other origin into USDC. */
const BRIDGE_CARRIED: readonly string[] = ["USDC", "USDT"]

/**
 * The deposit option a bridge-in of `symbol` lands as: the one of the same symbol when Across
 * carries it as itself and the table offers it, else USDC. The SIPA swaps the landing where its
 * row does.
 */
export const bridgeLanding = (coins: readonly DepositTokenOption[], symbol: string | undefined) =>
  symbol === undefined
    ? undefined
    : (BRIDGE_CARRIED.includes(symbol) ? coins.find((c) => c.symbol === symbol) : undefined) ??
      coins.find((c) => c.symbol === "USDC")

/**
 * What a bridge-in landing as `landing` credits, which the sheet names as its destination: the
 * landing's row token, `approx` where the SIPA swaps into it at the market rate.
 */
export const bridgeCredit = (
  coins: readonly DepositTokenOption[],
  landing: DepositTokenOption | undefined,
) =>
  landing && {
    coin: coins.find((c) => isAddressEqual(c.address, landing.settlesIn)) ?? landing,
    approx: landing.swapped,
  }

/** An RPC that refused, rate-limited or timed out a read. */
export const isUnreachable = (e: unknown) =>
  e instanceof BaseError &&
  !!e.walk(
    (c) =>
      c instanceof HttpRequestError ||
      c instanceof TimeoutError ||
      c instanceof LimitExceededRpcError,
  )

/**
 * What a bridge-in quotes for the typed amount. A request fixes what lands. Typed in From, the
 * amount leaves the wallet, fee included; typed in To, it reaches the private balance and the quote
 * asks for what must land for that. MAX sends the whole balance.
 *
 * A route that swaps on the origin chain quotes exact input only: Across delivers an exact output
 * of a swap through a message that pays part of the landing elsewhere. Typed in To, it sends what
 * lands that much at `rate`'s rate; with no rate yet, it quotes one origin coin, no more than a
 * balance it knows, to read one.
 */
export function bridgeSize({
  amount,
  side,
  fixedAmount,
  maxed,
  balance,
  inDecimals,
  outDecimals,
  needed,
  originSwap = false,
  rate,
}: {
  amount: string
  side: "from" | "to"
  fixedAmount?: string
  maxed: boolean
  balance?: bigint
  /** The origin token's decimals; unknown, nothing is quoted. */
  inDecimals?: number
  outDecimals: number
  /** What must land for `amount` to reach the private balance; unknown until the fee is. */
  needed?: (amount: bigint) => bigint | undefined
  /** The origin coin is not the coin that lands. */
  originSwap?: boolean
  /** The quote a To typed on an origin-swap route converts through. */
  rate?: Pick<BridgeInQuote, "fee" | "inputAmount" | "outputAmount">
}) {
  const toTyped = fixedAmount === undefined && side === "to"
  const inLanding = fixedAmount !== undefined || toTyped
  const exactOutput = fixedAmount !== undefined || (toTyped && !originSwap)
  const sendsAll = maxed && !inLanding && balance !== undefined
  const decimals = inLanding ? outDecimals : inDecimals
  const error = decimals === undefined ? undefined : amountError(amount, decimals)
  const atomic = amount && decimals !== undefined && !error ? parseUnits(amount, decimals) : 0n
  const typed = sendsAll ? balance : atomic > 0n ? atomic : undefined
  const output = toTyped && typed && needed ? needed(typed) : typed
  const input = !inLanding
    ? typed
    : exactOutput || !output
    ? undefined
    : rate
    ? bridgeInputFor(rate, output)
    : inDecimals !== undefined
    ? rateProbe(inDecimals, balance)
    : undefined
  const request =
    !typed || inDecimals === undefined
      ? undefined
      : exactOutput
      ? output
        ? { outputAmount: output }
        : undefined
      : input
      ? { inputAmount: input }
      : undefined
  return { toTyped, exactOutput, sendsAll, error, typed, output, request }
}

/**
 * One origin coin, or a smaller known balance. Only its rate is read, so it does not follow the typed
 * amount, which can ask Across for more of the origin coin than it has liquidity for.
 */
function rateProbe(inDecimals: number, balance?: bigint) {
  const one = 10n ** BigInt(inDecimals)
  return balance !== undefined && balance > 0n && balance < one ? balance : one
}

/**
 * The most a quote charges the wallet. A request pays its exact amount, so the bridge may pull up
 * to its slippage; a deposit sends its quote's input exactly.
 */
export const bridgeCharged = (
  quote: Pick<BridgeInQuote, "inputAmount" | "maxInputAmount">,
  request: boolean,
) => (request ? quote.maxInputAmount : quote.inputAmount)

/**
 * The whole fee an amount Across refuses would pay, as a figure: the typed amount times their ratio
 * plus `depositFee`, in dollars at the landing coin or `rate`'s, else the bridge's share alone in the
 * origin coin.
 */
export function bridgeRefusedFee({
  refused,
  typed,
  output,
  exactOutput,
  dollars,
  inDecimals,
  outDecimals,
  rate,
  symbol,
  depositFee,
}: {
  refused: { amount: bigint; fee: bigint } | undefined
  typed: bigint | undefined
  output: bigint | undefined
  exactOutput: boolean
  /** The origin coin is a dollar coin. */
  dollars: boolean
  inDecimals: number
  outDecimals: number
  /** The last quote, for its rate into the landing coin. */
  rate?: BridgeInQuote
  symbol: string
  /** The deposit fee, decimal in the landing coin, a dollar coin. */
  depositFee: string
}): string | undefined {
  if (!refused || !typed || refused.amount === 0n) return undefined
  const share = (atomic: bigint) => (atomic * refused.fee) / refused.amount
  const whole = (usd: string) => usdFigure(addDollars(usd, depositFee))
  if (exactOutput) return whole(formatUnits(share(output ?? typed), outDecimals))
  if (dollars) return whole(formatUnits(share(typed), inDecimals))
  const usd = rate && bridgeUsdValue(rate, share(typed), outDecimals)
  return usd !== undefined ? whole(usd) : coinFigure(share(typed), inDecimals, symbol)
}

/** Where bridging opens: the profile's first chain that is not the L1. */
export const preferredBridgeChain = <T extends { chainId: number }>(
  chains: readonly T[],
  l1ChainId: number,
) => chains.find((chain) => chain.chainId !== l1ChainId)

/**
 * The deposit flow's first network, never a coin. An address deposits on the L1. A wallet's flow
 * opens on the wallet's chain where offered. Then the last network picked here (never the L1 for a
 * bridge), the preferred bridge chain, the L1.
 */
export function firstDepositNetwork({
  intent,
  networks,
  l1ChainId,
  lastNetwork,
  walletChainId,
}: {
  intent?: "wallet" | "address" | "bridge"
  /** The L1 first, then the bridge chains in profile order. */
  networks: readonly { chainId: number }[]
  l1ChainId: number
  lastNetwork?: number
  /** The connected wallet's chain. */
  walletChainId?: number
}): number {
  if (intent === "address") return l1ChainId
  const offered = (id: number | undefined) => networks.find((n) => n.chainId === id)?.chainId
  const wallet = intent === "wallet" ? offered(walletChainId) : undefined
  const remembered =
    intent === "bridge" && lastNetwork === l1ChainId ? undefined : offered(lastNetwork)
  return wallet ?? remembered ?? preferredBridgeChain(networks, l1ChainId)?.chainId ?? l1ChainId
}

/**
 * The profile's bridge-in provider and its deposit lookup: one Across client for both, reading
 * token decimals with `decimals`, or the demo's `fake` provider, which looks up no deposits. Null
 * where the profile names no bridge.
 */
export function bridgeInSource(
  config: Pick<WebWalletConfig, "bridge">,
  decimals: TokenDecimals,
  fake?: BridgeInProvider,
): { provider: BridgeInProvider | null; deposits: BridgeInDepositLookup | null } {
  const bridge = profileBridge(config)
  if (!bridge) return { provider: null, deposits: null }
  if (fake) return { provider: fake, deposits: null }
  const contracts: AcrossContracts = {
    origin: new Map(
      bridge.chains.map((chain) => [chain.chainId, (chain.contracts ?? []) as Address[]]),
    ),
    bridged: new Map(
      bridge.chains.map((chain) => [
        chain.chainId,
        new Map(
          chain.in.flatMap((t) => ("address" in t ? [[t.symbol, t.address as Address]] : [])),
        ),
      ]),
    ),
    ...(bridge.multicallHandler && { multicallHandler: bridge.multicallHandler as Address }),
  }
  const across = new AcrossBridgeIn(bridge.apiUrl, contracts, decimals)
  return { provider: across, deposits: across }
}

/** A bridge chain's public client, one per chain of `config`'s profile; an unlisted chain throws. */
export function bridgeChainClients(
  config: Pick<WebWalletConfig, "bridge">,
): (chainId: number) => PublicClient<Transport, Chain> {
  const clients = new Map<number, PublicClient<Transport, Chain>>()
  return (chainId) => {
    let client = clients.get(chainId)
    if (!client) {
      const chain = profileBridge(config)?.chains.find((c) => c.chainId === chainId)
      if (!chain) throw new WalletError("invariant", `No bridge chain ${chainId} to read`)
      client = createPublicClient({ chain: bridgeChainFor(chain), transport: http() })
      clients.set(chainId, client)
    }
    return client
  }
}

/** A token's symbol and decimals on an origin chain. */
export interface OriginTokenFacts {
  symbol: string
  decimals: number
}

/** The bridge-in's origin reads and quotes, built once by the page. */
export function bridgeInQueries(
  query: QueryFactory,
  deps: {
    client: (chainId: number) => PublicClient<Transport, Chain>
    origin: Pick<OriginChain, "token">
    provider: Service<BridgeInProvider | null>
    /** A demo page's reads in place of these. */
    loaders?: {
      originBalance?: (chainId: number, token: Address, account: Address) => Promise<bigint>
      originToken?: (chainId: number, token: Address) => Promise<OriginTokenFacts>
      bridgeInQuote?: (request: BridgeInQuoteRequest) => Promise<BridgeInQuote>
    }
  },
) {
  const { client, origin, provider, loaders = {} } = deps
  return {
    /** A wallet's balance of a token on an origin chain, read again on every read. */
    originBalance: query<[number, Address, Address], bigint>("originBalance", {
      load: (chainId, token, account) =>
        loaders.originBalance
          ? loaders.originBalance(chainId, token, account)
          : isNativeToken(token)
          ? client(chainId).getBalance({ address: account })
          : client(chainId).readContract({
              address: token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account],
            }),
      stale: 0,
    }),
    /** A token on an origin chain, as the chain itself has it: its gas token, else the contract. */
    originToken: query<[number, Address], OriginTokenFacts>("originToken", {
      load: async (chainId, token) => {
        if (loaders.originToken) return loaders.originToken(chainId, token)
        if (isNativeToken(token)) {
          const { symbol, decimals } = client(chainId).chain.nativeCurrency
          return { symbol, decimals }
        }
        return origin.token(chainId, token)
      },
    }),
    /** The provider's quote per request, read again on every read. A refusal is the entry's `error`. */
    bridgeInQuote: query<[BridgeInQuoteRequest], BridgeInQuote>("bridgeInQuote", {
      load: async (request, signal) => {
        if (loaders.bridgeInQuote) return loaders.bridgeInQuote(request)
        const bridge = await provider.ready(signal)
        if (!bridge) throw new WalletError("invariant", "No bridge to quote")
        return bridge.quote(request)
      },
      stale: 0,
    }),
  }
}

/** The amount and fee a `bridge.belowFee` refusal carries, base units of the origin coin. */
export function bridgeBelowFee(e: unknown): { amount: bigint; fee: bigint } | undefined {
  if (!(e instanceof WalletError) || e.code !== "bridge.belowFee") return undefined
  const { amount, fee } = e.data ?? {}
  return amount && fee ? { amount: BigInt(amount), fee: BigInt(fee) } : undefined
}

/** The symbol the profile lists for `token` on bridge chain `chainId`. */
export function listedBridgeSymbol(
  config: Pick<WebWalletConfig, "bridge">,
  chainId: number,
  token: Address,
): string | undefined {
  const chain = profileBridge(config)?.chains.find((c) => c.chainId === chainId)
  return chain?.in.find((t) => isAddressEqual(tokenAddress(t), token))?.symbol
}

/** Reads bridge fills from funding receipts on `client`'s L1. */
export function fillReader(client: Pick<PublicClient, "getTransactionReceipt">): FillReader {
  return {
    fill: async (hash, recipient) =>
      acrossFillIn((await client.getTransactionReceipt({ hash })).logs, recipient),
  }
}

/** Bridge fills on `config`'s L1, over a client built on the first read. */
export function bridgeFills(config: WebWalletConfig): FillReader {
  let reader: FillReader | undefined
  return {
    fill: (hash, recipient) =>
      (reader ??= fillReader(l1PublicClient(config))).fill(hash, recipient),
  }
}
