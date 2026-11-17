import {
  createPublicClient,
  custom,
  encodeAbiParameters,
  formatUnits,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem"
import {
  deploymentOfTuples,
  EXECUTOR_PROJECT,
  holdingCatalog,
  pinnedHoldings,
  SKY_PROJECT,
  SKY_ROLES,
  VAULT_PROJECT,
  VAULT_ROLES,
  type PinnedOxideDeployment,
} from "@obsidion/core/oxide"
import {
  balanceScope,
  executorRoutes,
  RELAYER_MAX_PENDING_AGE_MS,
  skyEscrowRoutes,
  vaultSwapTargets,
  WalletError,
  type BuiltMove,
  type MoveDirection,
  type MoveQuote,
} from "@obsidion/front-core"
import { DEMO_COMPLETE_ADDRESS, DEMO_OXIDE_TUPLE } from "../../../src/dev/demoFixtures"
import {
  DEMO_WITHDRAWAL_FEE,
  DEMO_WITHDRAWAL_FEE_BENEFICIARY,
  installL1RpcStub,
  type RpcHandler,
} from "../../../src/dev/fakeL1Rpc"
import { moveRails } from "../../../src/features/savings/movesSession"
import type { Session } from "../../../src/session/session"
import { fixtureState } from "./control"
import { field, ROLLUP, TX_HASH } from "./data"

const UNIT = 10n ** 18n
const MAIN_BRIDGE = "brg-dai-capture"
const FACTORY = "0x5e5c000000000000000000000000000000000fac"

/** A vault the fixture holds shares of: its bridge, its price now and a rate window ago. */
interface FixtureLine {
  holding: string
  bridgeId: string
  portal: Address
  vault: Address
  sharesToken: Hex
  shareSymbol: string
  asset: Address
  assetSymbol: string
  /** Answered for the asset where the demo's 18 is wrong. */
  assetDecimals?: number
  sharePrice: bigint
  sharePriceBefore: bigint
  shares: bigint
  /** What the shares cost, in the asset. */
  cost: bigint
}

/** Sky: 500 shares at 1.10, worth $550.00 at 3.8% a year; they cost $540.00. */
const SKY: FixtureLine = {
  holding: "fea-sky-capture",
  bridgeId: "brg-susds-capture",
  portal: "0xde1100000000000000000000000000000000da02",
  vault: "0x5a5d500000000000000000000000000000005a5d",
  sharesToken: `0x${"5d".repeat(32)}`,
  shareSymbol: "sUSDS",
  asset: "0x05d5000000000000000000000000000000005d50",
  assetSymbol: "USDS",
  sharePrice: (11n * UNIT) / 10n,
  sharePriceBefore: 1_099_211n * 10n ** 12n,
  shares: 500n * UNIT,
  cost: 540n * UNIT,
}

/** A USDC vault: 300 shares at 1.05, worth $315.00 at 6.5% a year; they cost $300.00. */
const USDC_VAULT: FixtureLine = {
  holding: "fea-vault-capture",
  bridgeId: "brg-vault-capture",
  portal: "0xde1100000000000000000000000000000000da03",
  vault: "0x7a01700000000000000000000000000000007a01",
  sharesToken: `0x${"7a".repeat(32)}`,
  shareSymbol: "vUSDC",
  asset: "0x05dc000000000000000000000000000000005dc0",
  assetSymbol: "USDC",
  assetDecimals: 6,
  sharePrice: 1_050_000n,
  sharePriceBefore: 1_048_733n,
  shares: 300n * UNIT,
  cost: 300n * 10n ** 6n,
}

/** A USDT vault the swap fixtures hold: 200 shares at 1.02, worth $204.00 at 8.1% a year. */
const USDT_VAULT: FixtureLine = {
  holding: "fea-vault-usdt-capture",
  bridgeId: "brg-vault-usdt-capture",
  portal: "0xde1100000000000000000000000000000000da04",
  vault: "0x7a02700000000000000000000000000000007a02",
  sharesToken: `0x${"7b".repeat(32)}`,
  shareSymbol: "vUSDT",
  asset: "0x05d7000000000000000000000000000000005d70",
  assetSymbol: "USDT",
  assetDecimals: 6,
  sharePrice: 1_020_000n,
  sharePriceBefore: 1_018_473n,
  shares: 200n * UNIT,
  cost: 200n * 10n ** 6n,
}

/** A DAI vault the swap fixtures list without holding, at 4.2% a year. */
const DAI_VAULT: FixtureLine = {
  holding: "fea-vault-dai-capture",
  bridgeId: "brg-vault-dai-capture",
  portal: "0xde1100000000000000000000000000000000da05",
  vault: "0x7a03700000000000000000000000000000007a03",
  sharesToken: `0x${"7c".repeat(32)}`,
  shareSymbol: "vDAI",
  asset: "0x05da000000000000000000000000000000005da0",
  assetSymbol: "DAI",
  sharePrice: 1_010_000n * 10n ** 12n,
  sharePriceBefore: 1_009_201n * 10n ** 12n,
  shares: 0n,
  cost: 0n,
}

/** Both tips of a move, in DAI; a move in also pays the executor's fee. */
const TIPS = (56n * UNIT) / 100n

/** A fixture: the lines it holds shares of, in deployment order, and what its profile lists. */
interface FixtureSpec {
  held: readonly FixtureLine[]
  /** Undefined: the profile names none, so the deployment's default lists. */
  listed?: readonly FixtureLine[]
  /** The balance store has not read the shares yet. */
  unread?: true
  /** How the USDC vault's price reads go: no rate a window ago, or no price at all. */
  vault?: "unrated" | "unpriced"
  /** The profile has no words for its lines. */
  unworded?: true
  /** The executor has the Sky converter adapter, so Sky swaps with its vaults. */
  skyConverter?: true
}

const BOTH = { held: [SKY, USDC_VAULT], listed: [SKY, USDC_VAULT] } as const
/** Three vaults on the executor, so each swaps into the others. */
const SWITCH = {
  held: [USDC_VAULT, USDT_VAULT],
  listed: [USDC_VAULT, USDT_VAULT, DAI_VAULT],
} as const

const FIXTURES = {
  funded: { held: [SKY] },
  vaults: BOTH,
  delayed: BOTH,
  fresh: { held: [SKY], listed: [SKY, USDC_VAULT] },
  exit: { held: [SKY, USDC_VAULT], listed: [SKY] },
  delisted: { held: [SKY], listed: [] },
  loading: { ...BOTH, unread: true },
  unrated: { ...BOTH, vault: "unrated" },
  unpriced: { ...BOTH, vault: "unpriced" },
  unworded: { held: [SKY], unworded: true },
  switch: SWITCH,
  switched: SWITCH,
  switchUnworded: { ...SWITCH, unworded: true },
  skySwitch: { ...BOTH, skyConverter: true },
} as const satisfies Record<string, FixtureSpec>
type SavingsFixture = keyof typeof FIXTURES
const spec = (fixture: SavingsFixture): FixtureSpec => FIXTURES[fixture]
/** The lines the deployment binds: those held, then those listed but not held. */
const deployed = ({ held, listed = [] }: FixtureSpec) => [
  ...held,
  ...listed.filter((line) => !held.includes(line)),
]

/** What the fixtures' profile calls each line; the vault is new. */
const WORDS = {
  [SKY.holding]: {
    rateName: "Sky Savings Rate",
    yieldFrom: "Sky Savings Rate, set by Sky governance",
    moveBack: "Any time",
    risk: "Low · backed 1:1 by dollar assets",
    provider: "Sky",
    terms: [
      {
        label: "Terms of Use",
        url: "https://docs.sky.money/legal/skybase-international/terms-of-use",
      },
      { label: "User Risks", url: "https://docs.sky.money/legal/skybase-international/user-risks" },
    ],
  },
  [USDC_VAULT.holding]: {
    rateName: "Steakhouse Prime on Morpho",
    new: true,
    yieldFrom: "Interest from USDC loans on Morpho",
    moveBack: "When the vault has funds free",
    risk: "Medium · lent to borrowers, curated by Steakhouse",
    provider: "Morpho",
    terms: [{ label: "Terms of Use", url: "https://morpho.org/terms-of-use" }],
  },
  [USDT_VAULT.holding]: {
    rateName: "USDT Prime on Morpho",
    yieldFrom: "Interest from USDT loans on Morpho",
    moveBack: "When the vault has funds free",
    risk: "Medium · lent to borrowers, curated on Morpho",
    provider: "Morpho",
    terms: [{ label: "Terms of Use", url: "https://morpho.org/terms-of-use" }],
  },
  [DAI_VAULT.holding]: {
    rateName: "DAI Core on Morpho",
    yieldFrom: "Interest from DAI loans on Morpho",
    moveBack: "When the vault has funds free",
    risk: "Medium · lent to borrowers, curated on Morpho",
    provider: "Morpho",
    terms: [{ label: "Terms of Use", url: "https://morpho.org/terms-of-use" }],
  },
}

/**
 * `?savingsFixture=<name>`: `funded` is one Sky holding with shares, a price, a settled move and
 * one on its way; `vaults` adds a listed USDC vault the account also holds; `delayed` holds both
 * with a move the relayer dropped in place of the one on its way. `fresh` lists the vault without
 * holding it. `exit` lists Sky alone while the vault's shares stay held; `delisted` lists none
 * while Sky's do. `loading` holds both with their shares unread; `unrated` reads no rate for the
 * vault, and `unpriced` no price. `unworded` is `funded` under a profile with no words. `switch`
 * holds a USDC and a USDT vault and lists a DAI one too, all on the executor, so each swaps into
 * the others; `switched` adds a swap pending, done, delayed and recovered; `switchUnworded` is
 * `switch` under a profile with no words. `skySwitch` holds Sky and the USDC vault on an executor
 * with the Sky converter adapter, so each swaps into the other. It needs an active `flowFixture`,
 * and each path a plan loads carries it.
 */
export function savingsFixture(): SavingsFixture | null {
  const name = new URLSearchParams(location.search).get("savingsFixture")
  if (name === null || !fixtureState()) return null
  if (!Object.hasOwn(FIXTURES, name))
    throw new WalletError("invariant", `unknown savings fixture ${name}`)
  return name as SavingsFixture
}

/** The holdings `fixture`'s profile lists; undefined where the deployment's default stands. */
export const savingsListed = (fixture: SavingsFixture): readonly string[] | undefined =>
  spec(fixture).listed?.map((line) => line.holding)

/** `fixture`'s profile's words for each line. */
export const savingsWords = (fixture: SavingsFixture) => (spec(fixture).unworded ? {} : WORDS)

/**
 * The demo's bridge and each of `fixture`'s vault bridges: Sky's bound by a Sky feature, any other
 * by a vault feature on the deployment's executor.
 */
export function savingsDeployment(fixture: SavingsFixture = "funded"): PinnedOxideDeployment {
  const fixtureSpec = spec(fixture)
  const lines = deployed(fixtureSpec)
  const sky = {
    id: SKY.holding,
    project: SKY_PROJECT,
    bridges: { [SKY_ROLES.base]: MAIN_BRIDGE, [SKY_ROLES.held]: SKY.bridgeId },
    contracts: {
      skyEscrowFactory: FACTORY,
      skyWithdrawalExecutor: "0x5e5c000000000000000000000000000000000e8c",
    },
    variables: {},
  }
  const executor = {
    id: "fea-multistep-capture",
    project: EXECUTOR_PROJECT,
    bridges: {},
    contracts: {
      multiStepExecutor: "0xe8ec000000000000000000000000000000000e8e",
      portalDepositAdapter: "0xe8ec0000000000000000000000000000000000da",
      erc4626Adapter: "0xe8ec000000000000000000000000000000004626",
      ...(fixtureSpec.skyConverter
        ? { skyConverterAdapter: "0xe8ec0000000000000000000000000000000005c0" }
        : {}),
    },
    variables: {},
  }
  const vaults = lines
    .filter((line) => line !== SKY)
    .map((line) => ({
      id: line.holding,
      project: VAULT_PROJECT,
      bridges: { [VAULT_ROLES.base]: MAIN_BRIDGE, [VAULT_ROLES.held]: line.bridgeId },
      contracts: {},
      variables: { conversion: "None" },
    }))
  const features = [
    ...(lines.includes(SKY) ? [sky] : []),
    ...(vaults.length > 0 ? [executor, ...vaults] : []),
  ]
  const deployment = deploymentOfTuples([
    { ...DEMO_OXIDE_TUPLE, bridgeId: MAIN_BRIDGE, features },
    ...lines.map((line) => ({
      ...DEMO_OXIDE_TUPLE,
      bridgeId: line.bridgeId,
      portal: line.portal,
      underlying: line.vault,
      l2Token: line.sharesToken,
    })),
  ])
  return { deployment, pinned: deployment.bridges[0]!, timestampMs: 0 }
}

const SELECTOR = {
  convertToAssets: toFunctionSelector("convertToAssets(uint256)"),
  asset: toFunctionSelector("asset()"),
  symbol: toFunctionSelector("symbol()"),
  decimals: toFunctionSelector("decimals()"),
}
const word = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`
const LINES = [SKY, USDC_VAULT, USDT_VAULT, DAI_VAULT]

/**
 * Answers each vault's reads, its symbol and the share price by the block asked, and its asset's
 * symbol and decimals; `vault` takes the USDC vault's price or rate away. `base` answers the rest.
 */
export function savingsRpc(base: RpcHandler, vault?: FixtureSpec["vault"]): RpcHandler {
  return async (method, params = []) => {
    const [call, block] = params as [{ data?: Hex; to?: string } | undefined, unknown]
    const to = method === "eth_call" ? call?.to?.toLowerCase() : undefined
    const selector = call?.data?.slice(0, 10)
    const asset = LINES.find((line) => line.asset === to)
    if (asset && selector === SELECTOR.symbol)
      return encodeAbiParameters([{ type: "string" }], [asset.assetSymbol])
    if (asset?.assetDecimals !== undefined && selector === SELECTOR.decimals)
      return word(BigInt(asset.assetDecimals))
    const line = LINES.find((held) => held.vault === to)
    if (line && selector === SELECTOR.convertToAssets) {
      const latest = block === undefined || block === "latest"
      // No data: a vault with no code at the block read, so no price or no rate.
      const reads = line === USDC_VAULT ? vault : undefined
      if (reads === "unpriced" || (reads === "unrated" && !latest)) return "0x"
      return word(latest ? line.sharePrice : line.sharePriceBefore)
    }
    if (line && selector === SELECTOR.symbol)
      return encodeAbiParameters([{ type: "string" }], [line.shareSymbol])
    if (line && selector === SELECTOR.asset)
      return encodeAbiParameters([{ type: "address" }], [line.asset])
    return base(method, params)
  }
}

/** A move's quote at its line's price and the fixture's fees, without an L1 read. */
function lineQuote(line: FixtureLine, direction: MoveDirection, amount: bigint): MoveQuote {
  const asset = 10n ** BigInt(line.assetDecimals ?? 18)
  const assets = (dai: bigint) => (dai * asset) / UNIT
  const fee = direction === "in" ? DEMO_WITHDRAWAL_FEE : 0n
  // In DAI: what the burn is worth, and what the fees leave of it.
  const value = direction === "in" ? amount : (((amount * line.sharePrice) / UNIT) * UNIT) / asset
  const net = value - fee - TIPS
  if (net <= 0n)
    throw new WalletError("move.tipsExceedAmount", "capture", {
      data: {
        tips: String(direction === "in" ? fee + TIPS : (assets(TIPS) * UNIT) / line.sharePrice),
      },
    })
  const conversionOut = direction === "in" ? assets(net) : net
  const expectedOut = direction === "in" ? (conversionOut * UNIT) / line.sharePrice : assets(value)
  return {
    routed: direction === "in" ? conversionOut : amount,
    relayerTip: TIPS / 2n,
    conversionOut,
    conversionMinOut: conversionOut,
    expectedOut,
    minOut: expectedOut,
    withdrawalFee: fee,
    ...(direction === "in" ? { feeBeneficiary: DEMO_WITHDRAWAL_FEE_BENEFICIARY } : {}),
  }
}

/** A move's quote at its holding's own price and asset decimals, as the move sheet reads it. */
export function savingsQuote(
  holdingId: string,
  direction: MoveDirection,
  amount: bigint,
): MoveQuote {
  const line = LINES.find((held) => held.holding === holdingId)
  if (!line) throw new WalletError("invariant", `no savings fixture line ${holdingId}`)
  return lineQuote(line, direction, amount)
}

/** An L1 the capture's routes never read: they are built only for the rails they bind. */
const NO_L1 = createPublicClient({
  transport: custom({
    request: () => Promise.reject(new WalletError("invariant", "the capture reads no rail's L1")),
  }),
})

/**
 * What the engine offers each of `fixture`'s lines to swap into, over the rails the session binds
 * for its holdings: the demo builds no account, so its own rails are never bound.
 */
export function savingsVaultSwapTargets(
  fixture: SavingsFixture,
): ReadonlyMap<string, readonly string[]> {
  const deployment = pinnedHoldings(savingsDeployment(fixture))
  const { holdings: listed } = holdingCatalog(deployment, savingsListed(fixture))
  const routes = {
    sky: () =>
      skyEscrowRoutes({
        l1: NO_L1,
        broadcaster: () =>
          Promise.reject(new WalletError("invariant", "the capture binds no broadcaster")),
      }),
    executor: () => executorRoutes({ l1: NO_L1, eth: { chainId: 31337n } }),
  }
  const holdsVault = spec(fixture).held.some((line) => line !== SKY)
  return vaultSwapTargets(moveRails(deployment.holdings, listed, routes, holdsVault))
}

const lineOf = (holdingId: string) => {
  const line = LINES.find((held) => held.holding === holdingId)
  if (!line) throw new WalletError("invariant", `no capture line ${holdingId}`)
  return line
}

/** A swap's quote at both lines' prices, less the fixture's tips; the vaults take any amount. */
function vaultSwapQuote(from: FixtureLine, into: FixtureLine, amount: bigint): MoveQuote {
  const scale = (line: FixtureLine) => 10n ** BigInt(line.assetDecimals ?? 18)
  const redeemed = (amount * from.sharePrice) / UNIT
  // In DAI: what the shares are worth, and what the tips leave of it.
  const value = (redeemed * UNIT) / scale(from)
  const net = value - TIPS
  if (net <= 0n)
    throw new WalletError("move.tipsExceedAmount", "capture", {
      data: { tips: String((TIPS * amount) / value) },
    })
  const conversionOut = (net * scale(into)) / UNIT
  const expectedOut = (conversionOut * UNIT) / into.sharePrice
  return {
    // The shares the tips leave: the route keeps them, the relayer the rest.
    routed: (amount * net) / value,
    relayerTip: TIPS / 2n,
    conversionOut,
    conversionMinOut: conversionOut,
    expectedOut,
    minOut: expectedOut,
    withdrawalFee: 0n,
    out: { minOut: redeemed, conversionMinOut: net },
  }
}

/** A swap's quote without an L1 read. */
export const savingsVaultSwapQuote = (fromId: string, toId: string, amount: bigint): MoveQuote =>
  vaultSwapQuote(lineOf(fromId), lineOf(toId), amount)

const DAY = 86_400_000

/** The `delayed` fixture's move: a move in to Sky the relayer dropped after its max pending age. */
const DROPPED = {
  id: "capture-move-dropped",
  amount: 75n * UNIT,
  age: RELAYER_MAX_PENDING_AGE_MS + DAY,
}

/** The `switched` fixture's swaps out of the USDC vault, each in its own state. */
const SWITCHES: readonly {
  id: string
  into: FixtureLine
  amount: bigint
  age: number
  /** Past the burn: the route ran and the destination claimed, or the shares came back. */
  end?: "claimed" | "recovered"
}[] = [
  { id: "capture-switch-pending", into: USDT_VAULT, amount: 40n * UNIT, age: 6 * 60_000 },
  {
    id: "capture-switch-done",
    into: USDT_VAULT,
    amount: 50n * UNIT,
    age: 2 * DAY,
    end: "claimed",
  },
  {
    id: "capture-switch-dropped",
    into: DAI_VAULT,
    amount: 30n * UNIT,
    age: RELAYER_MAX_PENDING_AGE_MS + DAY,
  },
  {
    id: "capture-switch-recovered",
    into: USDT_VAULT,
    amount: 20n * UNIT,
    age: 4 * DAY,
    end: "recovered",
  },
]

/** What the `switched` fixture's swaps took from a line's shares, or landed in them. */
const switchedShares = (line: FixtureLine): bigint =>
  SWITCHES.reduce(
    (shares, { into, amount, end }) =>
      line === USDC_VAULT
        ? shares - amount
        : line === into && end === "claimed"
        ? shares + vaultSwapQuote(USDC_VAULT, into, amount).expectedOut
        : shares,
    0n,
  )

/** The recovery address the `switched` fixture's recovered swap paid. */
const RECOVERY_TO = "0x7ec0000000000000000000000000000000007ec0"

/**
 * Each line's shares under the demo account, the move that bought them, and a move in to Sky still
 * on its way, or under `delayed` the dropped move, or under `switched` its swaps.
 */
export async function seedSavings(session: Session, fixture: SavingsFixture): Promise<void> {
  const { balanceStore, milestones, moves, page, withdrawals } = session
  if (!balanceStore)
    throw new WalletError("wallet.notReady", "the savings fixture seeds an account")
  installL1RpcStub(
    page.config.l1RpcUrl,
    savingsRpc(
      (method, params) => window.ethereum!.request({ method, params }),
      spec(fixture).vault,
    ),
  )
  const now = Date.now()
  const scope = balanceScope(page.config.network, DEMO_COMPLETE_ADDRESS)
  const { held, unread } = spec(fixture)
  if (!unread)
    for (const line of deployed(spec(fixture)))
      await balanceStore.write(
        scope,
        line.sharesToken,
        (held.includes(line) ? line.shares : 0n) +
          (fixture === "switched" ? switchedShares(line) : 0n),
      )
  // No sync runs here, so the seeded balances are the first: Savings shows after it.
  milestones.mark("firstBalance")
  const move = (
    line: FixtureLine,
    id: string,
    amount: bigint,
    startTime: number,
    direction: MoveDirection = "in",
    into?: FixtureLine,
  ): BuiltMove => ({
    id,
    holdingId: line.holding,
    direction,
    ...(into ? { intoHoldingId: into.holding } : {}),
    amount,
    nonce: field("5e") as Hex,
    recipientCommitment: field("5f") as Hex,
    scanFrom: 0n,
    startTime,
    quote: into ? vaultSwapQuote(line, into, amount) : lineQuote(line, direction, amount),
    withdrawalLocalId: `capture-burn-${id}`,
    ...(line === SKY
      ? {
          rail: "skyEscrow",
          escrow: {
            factory: FACTORY,
            address: "0x5e5c00000000000000000000000000000000e5c0",
            tip: TIPS / 2n,
          },
        }
      : { rail: "executor", destination: (into ?? line).portal }),
  })
  // The burn, mined and waiting on its release: what a move's wait counts from.
  const burned = (
    built: BuiltMove,
    line: FixtureLine,
    startTime: number,
    phase: "finalizing_l1" | "done" = "finalizing_l1",
  ) =>
    withdrawals.create({
      localId: built.withdrawalLocalId!,
      networkId: ROLLUP,
      recipient: line === SKY ? FACTORY : line.portal,
      amount: formatUnits(built.amount, 18),
      rawAmount: built.amount.toString(),
      tokenSymbol: built.direction === "in" ? "DAI" : line.shareSymbol,
      tokenDecimals: 18,
      recipientProvenance: "saved-recipient",
      phase,
      startTime,
      ...(phase === "done" ? { endTime: startTime + 3_660_000 } : {}),
      minedAt: startTime,
      l2TxHash: TX_HASH as Hex,
      blockNumber: 4212,
    })
  const fees = DEMO_WITHDRAWAL_FEE + TIPS
  for (const [index, line] of held.entries()) {
    const cost = (line.cost * UNIT) / 10n ** BigInt(line.assetDecimals ?? 18)
    const id = line === SKY ? "capture-move-settled" : `capture-move-${line.holding}`
    const bought = move(line, id, cost + fees, now - (30 - index) * DAY)
    await moves.apply(bought.id, { type: "built", record: bought })
    await moves.apply(bought.id, { type: "burnMined" })
    await moves.apply(bought.id, { type: "released", txHash: TX_HASH as Hex, assets: line.cost })
    await moves.apply(bought.id, {
      type: "depositSeen",
      txHash: TX_HASH as Hex,
      deposit: {
        inboxIndex: BigInt(index + 1),
        amount: line.shares,
        at: bought.startTime + 3_600_000,
      },
    })
    await moves.apply(bought.id, { type: "claimed", at: bought.startTime + 3_660_000 })
  }
  if (fixture === "switched") {
    for (const [index, switched] of SWITCHES.entries()) {
      const startTime = now - switched.age
      const built = move(USDC_VAULT, switched.id, switched.amount, startTime, "out", switched.into)
      await moves.apply(built.id, { type: "built", record: built })
      await moves.apply(built.id, { type: "burnMined" })
      await burned(built, USDC_VAULT, startTime, switched.end ? "done" : "finalizing_l1")
      if (switched.end === "recovered")
        await moves.apply(built.id, {
          type: "recovered",
          txHash: TX_HASH as Hex,
          to: RECOVERY_TO,
          at: startTime + 3 * 3_600_000,
        })
      if (switched.end !== "claimed") continue
      const took = built.quote!.conversionOut
      await moves.apply(built.id, { type: "released", txHash: TX_HASH as Hex, assets: took })
      await moves.apply(built.id, {
        type: "depositSeen",
        txHash: TX_HASH as Hex,
        deposit: {
          inboxIndex: BigInt(held.length + index + 1),
          amount: built.quote!.expectedOut,
          at: startTime + 3_600_000,
        },
      })
      await moves.apply(built.id, { type: "claimed", at: startTime + 3_660_000 })
    }
    return
  }
  if (fixture !== "delayed") {
    if (!deployed(spec(fixture)).includes(SKY)) return
    const arriving = move(SKY, "capture-move-arriving", UNIT + fees, now - 540_000)
    await moves.apply(arriving.id, { type: "built", record: arriving })
    await moves.apply(arriving.id, { type: "burnMined" })
    return
  }
  const startTime = now - DROPPED.age
  const dropped = move(SKY, DROPPED.id, DROPPED.amount, startTime)
  await moves.apply(dropped.id, { type: "built", record: dropped })
  await moves.apply(dropped.id, { type: "burnMined" })
  await burned(dropped, SKY, startTime)
}
