import { WalletError } from "@obsidion/core/errors"
import type { PageFacts } from "../../session/pageChain"
import { formatUnits, getAddress, type Address } from "viem"
import { depositPayoutTokenFor, MAINNET_CHAIN_ID } from "@oxide/l1-contracts"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  bridgeByToken,
  SIPA_INTENT_NAMES,
  sipaIntentToken,
  type PinnedOxideDeployment,
  type OxideTableRow,
  type SipaIntentName,
} from "@obsidion/core/oxide"
import {
  depositRows,
  depositTokenRoutes,
  useStore,
  type SipaFundingToken,
} from "@obsidion/front-core"
import { readSipaPortalTerms, sipaIntentOf } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { useSession } from "../../session/session"
import { isDemoMode } from "../../dev/demoFlag"
import { l1PublicClient } from "../../config/oxideTuple"
import { ICONS } from "../../ui/CoinIcon/coinIcons"
import testIcon from "../../assets/deposit/ethereum.webp"

export interface DepositTokenOption {
  address: Address
  symbol: string
  decimals: number
  icon: string
  /** The row's token: what the sweep deposits and the row's portal holds. */
  settlesIn: Address
  /** The SIPA swaps this token into `settlesIn` before it deposits (mainnet USDC and USDT). */
  swapped: boolean
}

/** What a SIPA of the pinned table accepts for one intent. */
export interface DepositTokens {
  /** Every row's tokens, product rows included: what a sweep, a recovery or a record's lookup reads. Picker order. */
  options: DepositTokenOption[]
  /** Main's tokens: what the deposit, funding, request and limits surfaces offer. Picker order. */
  offered: DepositTokenOption[]
  /** The default pick: the pinned bridge's token for a deposit, the fee token for a registration. */
  settlement: DepositTokenOption
}

const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The option a picked token settles in: itself, or the row token it swaps into. */
export function settlementOf(tokens: DepositTokens, token: DepositTokenOption): DepositTokenOption {
  return tokens.options.find((t) => sameAddress(t.address, token.settlesIn)) ?? tokens.settlement
}

/** A token's ERC-20 symbol and decimals, off the page's read. */
export const tokenMetadata = ({ chain }: Pick<PageFacts, "chain">, token: Address) =>
  chain.tokenMetadata(token).read()

/** The chain whose SIPA swap rule applies. A dev demo shows the mainnet shape on any chain. */
function swapChainId(config: WebWalletConfig): bigint {
  return import.meta.env.DEV && isDemoMode() ? MAINNET_CHAIN_ID : BigInt(config.l1ChainId)
}

/**
 * Every token a SIPA of the pinned table accepts for `intent`, read off the table's rows, and the ones Main offers. The
 * profile's `assets` name and order the rows they match by portal: a row the profile omits is still listed, after the
 * named ones, and an asset with no row adds nothing. Main offers the rows of the profile's `portals.main`, or of its
 * `assets` that no feature binds as a product without one, so a bridge that the manifest adds is offered nowhere
 * until the profile names its portal.
 */
export async function loadDepositTokens(
  { config, chain }: PageFacts,
  intent: SipaIntentName = "deposit",
): Promise<DepositTokens> {
  const [{ pinned }, table] = await Promise.all([
    chain.oxideDeployment.read(),
    chain.deploymentTable.read(),
  ])
  const routes = depositTokenRoutes(table, swapChainId(config), intent)
  if (routes.length === 0) {
    throw new WalletError(
      "config.invalid",
      `The forwarding table routes no ${intent} sweep of any token`,
    )
  }
  const rank = (row: OxideTableRow) => {
    const listed = config.assets.findIndex((asset) => sameAddress(asset.portal, row.bridge.portal))
    return listed === -1 ? config.assets.length + table.rows.indexOf(row) : listed
  }
  const ordered = [...routes].sort((a, b) => rank(a.row) - rank(b.row))
  const options = await Promise.all(
    ordered.map(async (route): Promise<DepositTokenOption> => {
      const read = await tokenMetadata({ chain }, route.token)
      const named = route.swapped
        ? undefined
        : config.assets.find((asset) => sameAddress(asset.portal, route.row.bridge.portal))
      const symbol = named?.symbol ?? read.symbol
      return {
        address: route.token,
        symbol,
        decimals: read.decimals,
        icon: ICONS[symbol] ?? testIcon,
        settlesIn: route.row.bridge.underlying as Address,
        swapped: route.swapped,
      }
    }),
  )
  const main = new Set(depositRows(table, config.portals?.main).main)
  if (!config.portals && config.assets.length) {
    const named = new Set(
      depositRows(
        table,
        config.assets.map((asset) => asset.portal),
      ).main,
    )
    for (const row of main) if (!named.has(row)) main.delete(row)
  }
  const offered = options.filter((_, i) => main.has(ordered[i]!.row))
  const settles = intent === "deposit" ? pinned.underlying : table.deployment.feeToken
  const settlement =
    options.find((t) => !t.swapped && settles && sameAddress(t.address, settles)) ?? options[0]!
  return { options, offered, settlement }
}

/** A component's read of the accepted tokens. */
export interface DepositTokensRead {
  /** Undefined until read. */
  tokens?: DepositTokens
  /** The last read failed and none has landed since. A failed read is retried while shown. */
  failed: boolean
  /** Reads again now. */
  retry: () => void
}

/** {@link loadDepositTokens} for a component, with its loading and failure states. */
export function useDepositTokensRead(intent: SipaIntentName = "deposit"): DepositTokensRead {
  const read = useSession().page.depositTokens(intent)
  const state = useStore(read)
  return {
    tokens: state.status === "ready" ? state.value : undefined,
    failed: state.status === "failed",
    retry: read.refresh,
  }
}

/** {@link loadDepositTokens} for a component; undefined until read. A failed read is retried while shown. */
export function useDepositTokens(intent: SipaIntentName = "deposit"): DepositTokens | undefined {
  return useDepositTokensRead(intent).tokens
}

/**
 * What a deposit of `token` credits. A row's own token credits its L2 asset one to one, less the row fee; a token the
 * SIPA swaps credits `settlement`, its row's token, at the market rate.
 */
export function depositCreditNote(
  token: DepositTokenOption,
  settlement: DepositTokenOption,
): string {
  return token.swapped
    ? `${token.symbol} is swapped to ${settlement.symbol} at the market rate, so the ${settlement.symbol} credited can differ.`
    : `Each ${token.symbol} you send is credited as 1 ${token.symbol}, less the fee.`
}

/** The tokens of `tokens`, `head` first. */
export function fundingTokensFrom(
  tokens: Pick<DepositTokens, "options">,
  head: SipaFundingToken,
): [SipaFundingToken, ...SipaFundingToken[]] {
  return [
    head,
    ...tokens.options.flatMap(({ address, symbol, decimals }) =>
      sameAddress(address, head.address) ? [] : [{ address, symbol, decimals }],
    ),
  ]
}

/**
 * Every token a SIPA for `intent` may be funded with, `head` first. `head` names its symbol and decimals when the
 * caller knows them; otherwise the table's listing does.
 */
export async function sipaFundingTokens(
  page: PageFacts,
  head: Address | SipaFundingToken,
  intent: SipaIntentName = "deposit",
): Promise<[SipaFundingToken, ...SipaFundingToken[]]> {
  const tokens = await loadDepositTokens(page, intent)
  if (typeof head !== "string") return fundingTokensFrom(tokens, head)
  const listed = tokens.options.find((t) => sameAddress(t.address, head))
  const decimals = listed?.decimals ?? (await tokenMetadata(page, head)).decimals
  return fundingTokensFrom(tokens, { address: head, symbol: listed?.symbol ?? "", decimals })
}

/**
 * Every token a SIPA of the pinned table accepts for any intent, `head` first: what a recovery probes an address for.
 * Without the table it is `head` alone, so a recovery still moves the token it names.
 */
export async function recoveryProbeTokens(
  page: PageFacts,
  head: Address,
): Promise<[SipaFundingToken, ...SipaFundingToken[]]> {
  const reads = await Promise.allSettled(
    SIPA_INTENT_NAMES.map((intent) => loadDepositTokens(page, intent)),
  )
  const options: DepositTokenOption[] = []
  for (const read of reads) {
    if (read.status === "rejected")
      console.warn("[recovery] accepted tokens unavailable:", read.reason)
    else
      for (const option of read.value.options)
        if (!options.some((t) => sameAddress(t.address, option.address))) options.push(option)
  }
  const listed = options.find((t) => sameAddress(t.address, head))
  const decimals = listed?.decimals ?? (await tokenMetadata(page, head)).decimals
  return fundingTokensFrom({ options }, { address: head, symbol: listed?.symbol ?? "", decimals })
}

/** What the deposit screen quotes for one picked token: its row's fee and cap, and the row's token. */
export interface DepositDisplayFacts {
  /** The quoted fee, display units of the row's token. */
  fee: string
  /** The row's token. */
  token: Address
  /** The row's sweep fee, base units. */
  sweepFeeAtomic: bigint
  /** The row's portal `TX_AMOUNT_CAP()`, base units. */
  txAmountCap: bigint
}

/**
 * Quote a deposit of `token`: the sweep fee and the cap of the row it settles on, read fresh off that row alone. The
 * fee is stamped on the record a deposit creates, so the detail sheet can reproduce it.
 */
export async function loadDepositDisplayFacts(
  { config, chain }: PageFacts,
  token?: Pick<DepositTokenOption, "settlesIn">,
  intent: SipaIntentName = "deposit",
): Promise<DepositDisplayFacts> {
  const { deployment, pinned } = await chain.oxideDeployment.read()
  const settlesIn = (token?.settlesIn ?? pinned.underlying) as Address
  const bridge = bridgeByToken(deployment, settlesIn)
  if (!bridge || !deployment.forwardingTable) {
    throw new WalletError("config.invalid", `The deployment has no ${intent} row for ${settlesIn}`)
  }
  const [terms, { decimals }] = await Promise.all([
    readSipaPortalTerms(l1PublicClient(config), {
      forwardingTable: deployment.forwardingTable as Address,
      token: settlesIn,
      intent: sipaIntentOf(intent),
    }),
    tokenMetadata({ chain }, settlesIn),
  ])
  if (!sameAddress(terms.portal, bridge.portal)) {
    throw new WalletError(
      "config.invalid",
      `The forwarding table routes ${settlesIn} to ${terms.portal}, not its bridge`,
    )
  }
  return {
    fee: formatUnits(terms.depositFee, decimals),
    token: settlesIn,
    sweepFeeAtomic: terms.depositFee,
    txAmountCap: terms.txAmountCap,
  }
}

/** The symbol a funding in `token` settles in; `fallback` until the tokens are read, or for a token the table omits. */
export function settlementSymbol(
  tokens: DepositTokens | undefined,
  token: string | undefined,
  fallback: string,
): string {
  const funded = token && tokens?.options.find((t) => sameAddress(t.address, token))
  return funded && tokens ? settlementOf(tokens, funded).symbol : fallback
}

/**
 * The row token a recorded SIPA's funds in `token` settle on, by the swap rule and the intent's row
 * rule: the pinned bridge's underlying for a record that predates token tracking. Reads nothing.
 */
export function recordedRowToken(
  config: WebWalletConfig,
  { deployment, pinned }: PinnedOxideDeployment,
  intent: SipaIntentName,
  token: string | undefined,
): Address {
  const funded = token
    ? getAddress(
        depositPayoutTokenFor(swapChainId(config), EthAddress.fromString(token)).toString(),
      )
    : pinned.underlying
  return sipaIntentToken(deployment, intent, funded) as Address
}

/**
 * The row token a funding in `token` settles on: the pinned bridge's for a record that predates token tracking.
 * Undefined until read, or for a token the table omits.
 */
export function settlementToken(
  tokens: DepositTokens | undefined,
  token: string | undefined,
): Address | undefined {
  if (!token) return tokens?.settlement.settlesIn
  return tokens?.options.find((t) => sameAddress(t.address, token))?.settlesIn
}

/** The decimals of the row a funding in `token` settles on: the units of its record's amounts. */
export function settlementDecimals(
  tokens: DepositTokens | undefined,
  token: string | undefined,
): number | undefined {
  if (!tokens) return undefined
  const funded = token
    ? tokens.options.find((t) => sameAddress(t.address, token))
    : tokens.settlement
  return funded && settlementOf(tokens, funded).decimals
}
