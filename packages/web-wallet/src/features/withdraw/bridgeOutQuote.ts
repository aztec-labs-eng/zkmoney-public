import type { ConfigBridgeChain } from "@obsidion/config-client"
import { WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  ACROSS_INPUT_DECIMALS,
  WalletError,
  type BridgeOutProvider,
  type QueryFactory,
} from "@obsidion/front-core"
import {
  acrossBridgeRoute,
  fetchAcrossDepositStatus,
  quoteAcrossBridgeOnWithdraw,
  type BridgeOutProviderId,
  type BridgeOutQuote,
  type BridgeOutToken,
} from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import type { WebWalletConfig } from "../../config/env"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { profileBridge } from "../../session/walletChains"
import type { PageFacts } from "../../session/pageChain"
import { fillReader } from "../deposit/bridgeChains"
import { SWAP_QUOTE_MAX_AGE_MS, SWAP_QUOTE_REFRESH_MS } from "./swapQuotes"
import { withdrawalExecutor } from "./withdrawalFee"

type BridgeConfig = Pick<WebWalletConfig, "bridge">

/** A chain a withdrawal of L2 `l2Token` can land on, the bridge that carries it, and the tokens it delivers there. */
export interface BridgeOutChain {
  provider: BridgeOutProviderId
  l2Token: string
  chain: ConfigBridgeChain
  tokens: { symbol: BridgeOutToken; address: Address }[]
}

/** The bridge-out providers a page can build, in the order their routes list. */
export const BRIDGE_OUT_PROVIDERS: readonly BridgeOutProviderId[] = ["across"]

/** Oxide's Across escrow factory: the pinned manifest's, else the profile's. */
export function acrossEscrowFactory(
  config: BridgeConfig,
  tuple: Pick<OxideEnvTuple, "acrossBridgeEscrowFactory">,
): Address | undefined {
  const bridge = profileBridge(config)
  if (bridge?.provider !== "across") return undefined
  return (tuple.acrossBridgeEscrowFactory ?? bridge.escrowFactory) as Address | undefined
}

export const requireAcrossEscrowFactory = (config: BridgeConfig, tuple: OxideEnvTuple): Address => {
  const factory = acrossEscrowFactory(config, tuple)
  if (!factory)
    throw new WalletError("config.invalid", "No Across escrow factory for this deployment")
  return factory
}

/**
 * The profile's destinations Across can serve from `tuple`'s escrow: none without an escrow
 * factory, and only the tokens oxide's route table delivers to that chain.
 */
export function bridgeOutChains(
  config: BridgeConfig,
  tuple: Pick<OxideEnvTuple, "acrossBridgeEscrowFactory" | "l2Token">,
): BridgeOutChain[] {
  const bridge = profileBridge(config)
  if (!bridge || bridge.provider !== "across" || !acrossEscrowFactory(config, tuple)) return []
  return bridge.chains
    .map((chain) => ({
      provider: "across" as const,
      l2Token: tuple.l2Token,
      chain,
      tokens: chain.out
        .filter((token) => acrossBridgeRoute(token.symbol, chain.chainId))
        .map((token) => ({ symbol: token.symbol, address: token.address as Address })),
    }))
    .filter((route) => route.tokens.length > 0)
}

const acrossApiUrl = (config: BridgeConfig) => {
  const bridge = profileBridge(config)
  return bridge?.provider === "across" ? bridge.apiUrl : undefined
}

/** Any address will do: the simulation only prices the relayer's run. */
const QUOTE_SENDER = `0x${"5e".repeat(20)}` as Address

/** A bridge-out refused as too small: `floor` is the least burn whose escrow pays its relayer. */
export const isBridgeBelowFloor = (e: unknown): e is WalletError & { data: { floor: string } } =>
  e instanceof WalletError && e.code === "withdraw.bridgeBelowFloor" && !!e.data?.floor

/**
 * What a refusal of too small an amount names, in DAI units: the escrow relayer's tip, or, before
 * that tip is priced, Across's own fee or minimum in its USDC/USDT input, which leaves the escrow
 * tip out of the floor. oxide-client throws these as plain `Error`s, so their text is parsed
 * (vendor/oxide/yarn-project/oxide-client/src/withdraw_escrows/escrow_withdrawal.ts,
 * across_bridge.ts and across_api.ts); `bridgeFloor.test.ts` fails when that text drifts. Remove
 * once oxide-client throws typed escrow-floor errors.
 */
export function belowFloorCost(e: unknown): bigint | undefined {
  const message = e instanceof Error ? e.message : ""
  const tip = /^relayerTip \((\d+)\) must be below the escrow funding/.exec(message)?.[1]
  if (tip !== undefined) return BigInt(tip)
  const across =
    /below the Across minDeposit \((\d+)\)/.exec(message)?.[1] ??
    /must be above acrossFee \((\d+)\)/.exec(message)?.[1] ??
    /Bridge amount \d+ is too low to cover bridge fees (\d+)/.exec(message)?.[1]
  return across === undefined ? undefined : BigInt(across) * ACROSS_INPUT_TO_DAI
}

/** Scales Across's input units to DAI's 18 decimals. */
export const ACROSS_INPUT_TO_DAI = 10n ** BigInt(18 - ACROSS_INPUT_DECIMALS)

/** The decimals of what Across lands: the token on that chain, 18 for USDC and USDT on BNB. */
export const bridgeOutDecimals = (token: BridgeOutToken, chainId: number): number =>
  acrossBridgeRoute(token, chainId)?.acrossOutputTokenDecimals ?? ACROSS_INPUT_DECIMALS

/** The least burn a bridge-out clears: the withdrawal's fee and tips, then what the bridge costs. */
export const bridgeFloor = (
  quote: { withdrawalFee: bigint; proverTip: bigint },
  bridgeCost: bigint,
): bigint => quote.withdrawalFee + WITHDRAW_RELAYER_TIP + quote.proverTip + bridgeCost

/**
 * A bridge-out to price: `amount` DAI of L2 `l2Token`'s deployment to `token` on `chainId` over
 * `provider`, `proverTip` paid out of the burn.
 */
export interface BridgeOutAsk {
  provider: BridgeOutProviderId
  l2Token: string
  chainId: number
  token: BridgeOutToken
  amount: bigint
  proverTip: bigint
}

/** A bridge-out's quote, with the withdrawal fee and prover tip it was priced on. */
export type BridgeOutPriced = BridgeOutQuote & { withdrawalFee: bigint; proverTip: bigint }

/** A priced bridge-out, or a refusal naming the least burn that clears. */
export type BridgeOutAnswer =
  | { quote: BridgeOutPriced; below?: undefined }
  | { below: true; floor: bigint; quote?: undefined }

/**
 * What a bridge-out of `amount` DAI costs and lands, priced on L1 and with Across, on the executor
 * fee and escrow factory of `tuple`, the deployment that holds the burned token.
 */
export async function quoteBridgeOut(
  { config, chain }: PageFacts,
  tuple: OxideEnvTuple,
  args: BridgeOutAsk,
  price = quoteAcrossBridgeOnWithdraw,
): Promise<BridgeOutPriced> {
  const { proverTip } = args
  const route = acrossBridgeRoute(args.token, args.chainId)
  if (!route) throw new WalletError("invariant", "Across has no route there")
  const { fee: withdrawalFee } = await withdrawalExecutor(chain, tuple)
  const quote = await price(
    l1PublicClient(config),
    {
      acrossBridgeEscrowFactory: requireAcrossEscrowFactory(config, tuple),
      operationExecutor: requireTupleField(tuple, "operationExecutor") as Address,
      dai: requireTupleField(tuple, "token") as Address,
      withdrawalSubsidy: requireTupleField(tuple, "withdrawalSubsidy") as Address,
    },
    {
      route,
      amount: args.amount,
      withdrawalFee,
      withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
      proverTip,
      escrowFunding: args.amount - withdrawalFee - WITHDRAW_RELAYER_TIP - proverTip,
      sender: QUOTE_SENDER,
      acrossApiUrl: acrossApiUrl(config),
    },
  ).catch((e: unknown) => {
    const cost = belowFloorCost(e)
    if (cost === undefined)
      throw new WalletError("bridge.quoteFailed", "bridge-out quote", { cause: e })
    const floor = bridgeFloor({ withdrawalFee, proverTip }, cost).toString()
    throw new WalletError("withdraw.bridgeBelowFloor", `below ${floor}`, {
      cause: e,
      data: { floor },
    })
  })
  return { ...quote, withdrawalFee, proverTip }
}

/**
 * The least burn an answer names: a refusal's floor, else the quote's own escrow tip and Across
 * fee, near the floor's as both are mostly gas.
 */
export const answerFloor = (answer: BridgeOutAnswer): bigint =>
  answer.below
    ? answer.floor
    : bridgeFloor(
        answer.quote,
        answer.quote.tip.relayerTip + answer.quote.acrossFee * ACROSS_INPUT_TO_DAI,
      )

/** How far a send's fresh quote may land below the review's before the review shows it. */
export const BRIDGE_OUT_REPRICE_PERCENT = 1n

/**
 * The quote a send burns: `fresh`, read at the send, unless it refuses or lands less than
 * `reviewed` beyond {@link BRIDGE_OUT_REPRICE_PERCENT}.
 */
export const bridgeOutSendable = (
  reviewed: Pick<BridgeOutQuote, "minReceived">,
  fresh: BridgeOutAnswer,
): BridgeOutPriced | undefined =>
  fresh.quote &&
  fresh.quote.minReceived * 100n >= reviewed.minReceived * (100n - BRIDGE_OUT_REPRICE_PERCENT)
    ? fresh.quote
    : undefined

/** A bridge-out provider as the web wallet prices and lists it. */
export type WebBridgeOut = BridgeOutProvider<BridgeOutChain, BridgeOutAsk, BridgeOutPriced>

/**
 * Across, from oxide's escrow: its routes and quotes on the deployment that holds each token, and
 * its report on a deposit, read from the destination chain over `client`.
 */
export function acrossBridgeOut(
  facts: PageFacts,
  deps: {
    tupleOf: (token: string) => Promise<OxideEnvTuple>
    client: (chainId: number) => Pick<PublicClient, "getTransactionReceipt">
    price?: typeof quoteAcrossBridgeOnWithdraw
  },
): WebBridgeOut {
  const { config } = facts
  return {
    id: "across",
    routes: async (token) => bridgeOutChains(config, await deps.tupleOf(token)),
    quote: async (ask) => quoteBridgeOut(facts, await deps.tupleOf(ask.l2Token), ask, deps.price),
    async status(executeTxHash) {
      const status = await fetchAcrossDepositStatus(executeTxHash, {
        baseUrl: acrossApiUrl(config),
      })
      if (status?.status === "filled" || status?.status === "refunded") return status
      return status && { status: "pending" }
    },
    fill: async (chainId, fillTxHash, recipient) =>
      profileBridge(config)?.chains.some((c) => c.chainId === chainId)
        ? (await fillReader(deps.client(chainId)).fill(fillTxHash, recipient))?.value
        : undefined,
  }
}

/** The provider an ask or a record names; a page that does not configure it refuses. */
export function requireBridgeOut(
  bridgeOut: (provider: BridgeOutProviderId) => WebBridgeOut | null,
  provider: BridgeOutProviderId,
): WebBridgeOut {
  const built = bridgeOut(provider)
  if (!built) throw new WalletError("config.invalid", `No ${provider} bridge-out on this page`)
  return built
}

/**
 * The bridge-out quotes and routes, built once by the page: each ask priced by its provider, and
 * the routes of every provider the page configures. `quote` and `routes` stand in for a demo.
 */
export function bridgeOutQueries(
  query: QueryFactory,
  facts: PageFacts,
  deps: {
    bridgeOut: (provider: BridgeOutProviderId) => WebBridgeOut | null
    quote?: (facts: PageFacts, ask: BridgeOutAsk) => Promise<BridgeOutPriced>
    routes?: (token: string) => Promise<BridgeOutChain[]>
  },
) {
  const { bridgeOut } = deps
  const quote =
    deps.quote ??
    ((_: PageFacts, ask: BridgeOutAsk) => requireBridgeOut(bridgeOut, ask.provider).quote(ask))
  const routes =
    deps.routes ??
    (async (token: string) => {
      const providers = BRIDGE_OUT_PROVIDERS.flatMap((id) => bridgeOut(id) ?? [])
      return (await Promise.all(providers.map((p) => p.routes(token)))).flat()
    })
  return {
    /** Polled while shown; a refusal of too small an amount is an answer, not an error. */
    bridgeOutQuote: query<[BridgeOutAsk], BridgeOutAnswer>("bridgeOutQuote", {
      load: (ask) =>
        quote(facts, ask).then(
          (priced): BridgeOutAnswer => ({ quote: priced }),
          (e: unknown): BridgeOutAnswer => {
            if (isBridgeBelowFloor(e)) return { below: true, floor: BigInt(e.data.floor) }
            throw e
          },
        ),
      poll: SWAP_QUOTE_REFRESH_MS,
      stale: SWAP_QUOTE_MAX_AGE_MS,
    }),
    /** The bridge-out routes of the deployment that holds `token`. */
    bridgeOutRoutes: query<[string], BridgeOutChain[]>("bridgeOutRoutes", { load: routes }),
  }
}
