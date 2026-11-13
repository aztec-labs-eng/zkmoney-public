/**
 * Dev `/dev/mock/withdraw/<name>`: any view of the withdraw flow on fakes, no address, quote or
 * funds needed. This module fakes the balance, the saved wallets, the bridge routes, the address
 * reads, the quotes and the speed offer, and seeds each view's records and start.
 */
import { formatUnits, parseUnits } from "viem"
import type { Address, Hex } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  ACROSS_INPUT_DECIMALS,
  WalletError,
  memoryStore,
  type WithdrawalPhase,
  type WithdrawalRecord,
  type WithdrawalSpeedupEstimate,
} from "@obsidion/front-core"
import type { BridgeOutToken } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import type { PageLoaders } from "../../app/pageChain"
import type { Session } from "../../session/session"
import { delay } from "../delay"
import {
  ACROSS_INPUT_TO_DAI,
  bridgeOutChains,
  bridgeOutDecimals,
  type BridgeOutChain,
  type BridgeOutPriced,
} from "../../features/withdraw/bridgeOutQuote"
import type { L1AddressActivity } from "../../features/withdraw/addressFacts"
import { ETHERFI_CONTACT_NAME } from "../../features/withdraw/etherfi"
import { ETHERFI_PROVIDER } from "../../session/savedL1Wallets"
import type { EtherfiAddressVerdict } from "../../features/withdraw/etherfiCheck"
import type { FreshQuote } from "../../features/withdraw/freshAddressGateway"
import type { LoadFasterWithdrawal } from "../../features/withdraw/useFasterWithdrawal"
import type { SwapQuote } from "../../features/withdraw/withdrawQuote"
import type { WithdrawStep } from "../../features/withdraw/withdrawQuoteView"
import type { WithdrawStart } from "../../features/withdraw/WithdrawFlow/withdrawStart"
import type { WithdrawSent } from "../../features/withdraw/WithdrawFlow/withdrawTransition"
import type { WithdrawStage } from "../../features/withdraw/withdrawGateway"
import type { WithdrawalReceiveAsset } from "../../features/withdraw/withdrawAssets"
import { DEMO_NETWORK_ID, DEMO_OXIDE_TUPLE, demoAcrossExit } from "../demoFixtures"
import { playJourney, savedWallet, seedSavedWallets, type DemoMock } from "../demoMock"
import type { WithdrawMockName } from "../../app/devRoutes"

/** A view's start as a mock declares it: the prompt as a flag, and the records it seeds. */
type Start = Omit<WithdrawStart, "signing"> & {
  signing?: boolean
  record?: WithdrawalRecord
  /** States played in turn, `at` ms after the page opens. */
  journey?: { at: number; signing?: boolean; record?: WithdrawalRecord }[]
}

const RECIPIENT: Address = "0x7B3e9c41Ad02f8B5c6e1d7a9f04C3b8e2A61D9f0"
const LEDGER: Address = "0x2F91c6E0B8D47A3F5E2C19B0D6A8E7F43B1Da4c3"
const ETHERFI: Address = "0xe7f1a0c4d2b39e85f6a1C0D7B4E29f3a8C5D6e01"
const ESCROW: Address = "0x5Ca1Ab1e0000000000000000000000000000E5c0"
const TX = `0x${"9a".repeat(32)}` as Hex
const ENS_NAME = "rainbow.eth"
const LOCAL_ID = "wdraw_mock"

const dai = (amount: string) => parseUnits(amount, DEFAULT_DECIMALS)
const BALANCE = dai("1240.5")
/** Fast: 8 min for a 0.40 DAI tip; Standard: 30 min. */
const TIP = dai("0.4")
const STANDARD_ETA_SECONDS = 30 * 60
const FAST_ETA_SECONDS = 8 * 60
/** What every route takes besides the tip: $0.10, so Fast prices at $0.50. */
const BASE_FEE = dai("0.1")
/** What a swap loses to the pool: 500 DAI lands as 499.15 USDC. */
const SWAP_COST = dai("0.85")
/** What a gas share's second swap adds to the swap relayer's tip. */
const GAS_SWAP_TIP = dai("0.12")
const USD_PER_ETH = 3_000n

type Speed = "ready" | "loading" | "none" | "failed"
type Kind = "direct" | "swap" | "bridge"

/** What the reads say about one address: its L1 activity, ether.fi's answer and the screening. */
interface AddressReads {
  /** Unset, the read never answers. */
  activity?: L1AddressActivity
  /** What this wallet did with it, seeded as its records. */
  local?: "withdrew-before" | "linked-deposit"
  etherfi: EtherfiAddressVerdict["kind"] | "checking"
  screening: "compliant" | "blocked" | "error" | "screening"
}

const FRESH: L1AddressActivity = { code: false, nonce: 0, balance: 0n }

const READS = {
  fresh: { activity: FRESH, etherfi: "rejected", screening: "compliant" },
  used: {
    activity: { code: false, nonce: 4, balance: parseUnits("0.02", 18) },
    local: "withdrew-before",
    etherfi: "rejected",
    screening: "compliant",
  },
  exposed: {
    activity: { code: false, nonce: 9, balance: parseUnits("0.3", 18) },
    local: "linked-deposit",
    etherfi: "rejected",
    screening: "compliant",
  },
  ens: { activity: FRESH, etherfi: "rejected", screening: "compliant" },
  screened: { activity: FRESH, etherfi: "rejected", screening: "blocked" },
  screenError: { activity: FRESH, etherfi: "rejected", screening: "error" },
  timeout: { etherfi: "rejected", screening: "compliant" },
  checking: { etherfi: "checking", screening: "screening" },
  etherfi: {
    activity: { code: true, nonce: 1, balance: 0n },
    etherfi: "confirmed",
    screening: "compliant",
  },
} satisfies Record<string, AddressReads>

const SAVED = [savedWallet("Rainbow", RECIPIENT), savedWallet("Ledger", LEDGER)]
const SAVED_ETHERFI = savedWallet(ETHERFI_CONTACT_NAME, ETHERFI, ETHERFI_PROVIDER)

interface MockDef {
  saved?: boolean
  /** A saved ether.fi Cash address. */
  savedEtherfi?: boolean
  noBridge?: boolean
  /** The recipient's reads; the fresh ones when unset. */
  reads?: keyof typeof READS
  /** What ether.fi says about its own address; confirmed when unset. */
  etherfi?: EtherfiAddressVerdict["kind"]
  speed?: Speed
  /** The private balance in DAI; 1,240.50 when unset. */
  balance?: string
  start?: (routes: BridgeOutChain[], l1ChainId: number) => Start
}

const RAINBOW = { recipient: RECIPIENT, name: "Rainbow" }
const AT_AMOUNT: WithdrawStep[] = ["address", "amount"]
const AT_GAS: WithdrawStep[] = ["address", "amount", "gas"]
const AT_STATUS: WithdrawStep[] = ["address", "amount", "gas", "review", "status"]

const baseChain = (routes: BridgeOutChain[]) =>
  routes.find((r) => /base/i.test(r.chain.name)) ?? routes[0]

const address =
  (query: string = RECIPIENT, name = "Rainbow"): MockDef["start"] =>
  () => ({
    entry: {},
    history: ["address"],
    query,
    name,
  })
const etherfi =
  (query: string = ETHERFI): MockDef["start"] =>
  () => ({
    entry: { start: "etherfi" },
    history: ["etherfi"],
    query,
  })
const amount =
  (extra: Start = {}): MockDef["start"] =>
  () => ({
    entry: {},
    history: AT_AMOUNT,
    query: RECIPIENT,
    chosen: RAINBOW,
    ...extra,
  })
const bridged =
  (extra: Start = {}): MockDef["start"] =>
  (routes) => ({
    entry: {},
    history: AT_AMOUNT,
    query: RECIPIENT,
    chosen: RAINBOW,
    chainId: baseChain(routes)?.chain.chainId,
    coin: "USDC",
    amount: "500",
    ...extra,
  })

const quoteFor = (amountOut: bigint, decimals: number, proverTip: bigint): FreshQuote => ({
  relayerTip: dai("0.05"),
  amountOut,
  decimals,
  floorAtomic: BASE_FEE + proverTip,
  proverTip,
})

/** Oxide's bridge-out quote: the escrow tip, the 1% swap floor, then Across's fee. */
function bridgeQuote(amountAtomic: bigint, proverTip: bigint, decimals: number): BridgeOutPriced {
  const relayerTip = dai("0.05")
  const acrossFee = parseUnits("0.05", ACROSS_INPUT_DECIMALS)
  const atFloor =
    ((amountAtomic - proverTip - BASE_FEE - relayerTip) * 9_900n) / 10_000n / ACROSS_INPUT_TO_DAI
  return {
    acrossFee,
    minReceived: (atFloor - acrossFee) * 10n ** BigInt(decimals - ACROSS_INPUT_DECIMALS),
    tip: {
      relayerTip,
      minPayout: dai("0.04"),
      gasUsed: 180_000n,
      maxFeePerGas: 2_000_000_000n,
      usdPerEth: USD_PER_ETH * 10n ** 8n,
      baseFee: 1_500_000_000n,
      priorityFee: 500_000_000n,
    },
    withdrawalFee: BASE_FEE - WITHDRAW_RELAYER_TIP,
    proverTip,
  }
}

/** The withdrawal a status view shows: DAI direct, USDC with $5 of gas, or USDC on Base. */
function sentPlan(kind: Kind, routes: BridgeOutChain[], l1ChainId: number): WithdrawSent {
  const base = { recipient: RECIPIENT, name: "Rainbow", proverTip: TIP, speed: "faster" as const }
  if (kind === "direct")
    return {
      chain: "Ethereum",
      plan: {
        ...base,
        chainId: l1ChainId,
        coin: "DAI",
        amountAtomic: dai("500"),
        gasAtomic: 0n,
        burnAtomic: dai("500"),
        receivedAtomic: dai("499.5"),
        receivedDecimals: DEFAULT_DECIMALS,
        route: { kind: "direct", quote: quoteFor(dai("500"), DEFAULT_DECIMALS, TIP) },
        fresh: true,
      },
    }
  if (kind === "swap")
    return {
      chain: "Ethereum",
      plan: {
        ...base,
        chainId: l1ChainId,
        coin: "USDC",
        amountAtomic: dai("500"),
        gasAtomic: dai("5"),
        burnAtomic: dai("505.12"),
        receivedAtomic: parseUnits("498.65", 6),
        receivedDecimals: 6,
        route: { kind: "swap", quote: quoteFor(parseUnits("498.65", 6), 6, TIP) },
        fresh: true,
      },
    }
  const route = baseChain(routes)!
  const decimals = bridgeOutDecimals("USDC", route.chain.chainId)
  const quote = bridgeQuote(dai("500"), TIP, decimals)
  return {
    chain: route.chain.name,
    plan: {
      ...base,
      chainId: route.chain.chainId,
      coin: "USDC",
      amountAtomic: dai("500"),
      gasAtomic: 0n,
      burnAtomic: dai("500"),
      receivedAtomic: quote.minReceived,
      receivedDecimals: decimals,
      route: {
        kind: "bridge",
        choice: { chain: route.chain, token: "USDC", quote },
      },
      fresh: false,
    },
  }
}

/** The store's record for `sent` at `phase`, as the tracker would have written it. */
function sentRecord({ plan }: WithdrawSent, phase: WithdrawalPhase): WithdrawalRecord {
  const start = Date.now() - 4 * 60_000
  const { route } = plan
  const terminal = phase === "done" || phase === "failed" || phase === "recovered"
  return {
    localId: LOCAL_ID,
    recipient: plan.recipient,
    recipientAlias: plan.name,
    recipientProvenance: "saved-recipient",
    amount: formatUnits(plan.burnAtomic, DEFAULT_DECIMALS),
    rawAmount: plan.burnAtomic.toString(),
    tokenSymbol: "DAI",
    tokenDecimals: DEFAULT_DECIMALS,
    proverTip: plan.proverTip.toString(),
    phase,
    startTime: start,
    ...(phase !== "submitting" && {
      l2TxHash: TX,
      blockNumber: 4_812,
      minedAt: start + 60_000,
      phaseEnteredAt: Date.now() - 45_000,
    }),
    ...(route.kind !== "direct" && { swapOutput: plan.coin, swapEscrow: ESCROW }),
    ...(route.kind === "bridge" && {
      bridgeOut: {
        provider: "across" as const,
        chainId: plan.chainId,
        chainName: route.choice.chain.name,
        minReceived: route.choice.quote.minReceived.toString(),
        acrossFee: route.choice.quote.acrossFee.toString(),
        nonce: TX,
        recoveryCommitment: TX,
        relayerTip: route.choice.quote.tip.relayerTip.toString(),
      },
    }),
    ...(terminal && { endTime: start + 3 * 60_000 }),
  }
}

const status =
  (kind: Kind, at: { stage?: WithdrawStage; signing?: boolean; phase?: WithdrawalPhase }) =>
  (routes: BridgeOutChain[], l1ChainId: number): Start => {
    const sent = sentPlan(kind, routes, l1ChainId)
    return {
      entry: {},
      history: kind === "swap" ? AT_STATUS : ["address", "amount", "review", "status"],
      query: RECIPIENT,
      chosen: RAINBOW,
      chainId: sent.plan.chainId,
      coin: sent.plan.coin,
      amount: formatUnits(sent.plan.amountAtomic, DEFAULT_DECIMALS),
      gasAtomic: sent.plan.gasAtomic,
      speed: sent.plan.speed,
      stage: at.stage,
      signing: at.signing,
      ...(at.phase
        ? { sent: { ...sent, localId: LOCAL_ID }, record: sentRecord(sent, at.phase) }
        : { sent }),
    }
  }

/** 12.42 DAI to Rainbow on Ethereum with $5 of gas: confirm, prove, release, done. */
const journey: MockDef["start"] = (routes, l1ChainId) => {
  const direct = sentPlan("direct", routes, l1ChainId)
  const sent: WithdrawSent = {
    ...direct,
    plan: {
      ...direct.plan,
      amountAtomic: dai("12.42"),
      gasAtomic: dai("5"),
      burnAtomic: dai("17.92"),
      receivedAtomic: dai("12.42"),
      etaMinutes: 18,
    },
  }
  return {
    ...status("direct", { stage: "proving", signing: true })(routes, l1ChainId),
    sent: { ...sent, localId: LOCAL_ID },
    journey: [
      { at: 3_500, signing: false },
      { at: 8_000, signing: false, record: sentRecord(sent, "finalizing_l1") },
      { at: 12_000, signing: false, record: sentRecord(sent, "done") },
    ],
  }
}

export const WITHDRAW_MOCKS: Record<WithdrawMockName, MockDef> = {
  "landing": {},
  "landing-saved": {
    saved: true,
    reads: "used",
  },
  "landing-no-bridge": { noBridge: true },
  "address": { start: address("", "") },
  "address-fresh": { start: address() },
  "address-used": {
    reads: "used",
    start: address(),
  },
  "address-exposed": {
    reads: "exposed",
    start: address(),
  },
  "address-ens": {
    reads: "ens",
    start: address(ENS_NAME, ""),
  },
  "address-screened": {
    reads: "screened",
    start: address(),
  },
  "address-screen-error": {
    reads: "screenError",
    start: address(),
  },
  "address-timeout": {
    reads: "timeout",
    start: address(),
  },
  "address-checking": {
    reads: "checking",
    start: address(),
  },
  "etherfi": { start: etherfi("") },
  "etherfi-saved": {
    savedEtherfi: true,
    start: etherfi(""),
  },
  "etherfi-confirmed": { start: etherfi() },
  "etherfi-account": {
    etherfi: "account",
    start: etherfi(),
  },
  "etherfi-rejected": {
    etherfi: "rejected",
    start: etherfi(),
  },
  "etherfi-unknown": {
    etherfi: "unknown",
    start: etherfi(),
  },
  "amount": { start: amount() },
  "amount-typed": {
    start: amount({ amount: "500" }),
  },
  "amount-swap": {
    start: amount({ coin: "USDC", amount: "500" }),
  },
  "amount-bridge": {
    start: bridged(),
  },
  "amount-etherfi": {
    start: () => ({
      entry: {},
      history: AT_AMOUNT,
      query: ETHERFI,
      chosen: { recipient: ETHERFI, name: "ether.fi Cash" },
      coin: "USDC",
      amount: "500",
    }),
  },
  "amount-max": {
    start: amount({ maxed: true }),
  },
  "amount-to-typed": {
    start: amount({ coin: "USDC", amount: "100", side: "to" }),
  },
  "amount-fee-floor": {
    start: amount({ amount: "0.3" }),
  },
  "amount-fast-checking": {
    speed: "loading",
    start: amount({ amount: "500" }),
  },
  "amount-fast-none": {
    speed: "none",
    start: amount({ amount: "500" }),
  },
  "amount-eta-none": {
    speed: "failed",
    start: amount({ amount: "500" }),
  },
  "picker": {
    start: amount({ amount: "500", picker: true }),
  },
  "amount-over-balance": {
    start: amount({ amount: "2000" }),
  },
  "gas": {
    start: amount({ history: AT_GAS, coin: "USDC", amount: "500" }),
  },
  "gas-has-eth": {
    reads: "used",
    start: amount({ history: AT_GAS, coin: "USDC", amount: "500", gasAtomic: 0n }),
  },
  "gas-short": {
    balance: "503",
    start: amount({ history: AT_GAS, coin: "USDC", amount: "500", gasAtomic: dai("1") }),
  },
  "review": {
    start: amount({
      history: [...AT_GAS, "review"],
      coin: "USDC",
      amount: "500",
    }),
  },
  "review-dai": {
    start: amount({
      history: ["address", "amount", "review"],
      amount: "500",
      speed: "standard",
    }),
  },
  "review-bridge": {
    start: bridged({ history: ["address", "amount", "review"] }),
  },
  "review-fee-changed": {
    start: amount({
      history: ["address", "amount", "review"],
      amount: "500",
      speed: "standard",
      feeChanged: true,
    }),
  },
  "status-building": {
    start: status("swap", { stage: "building" }),
  },
  "status-passkey": {
    start: status("swap", { stage: "proving", signing: true }),
  },
  "status-proving": {
    start: status("swap", { stage: "proving" }),
  },
  "status-submitting": {
    start: status("swap", { stage: "submitting" }),
  },
  "status-l2-mined": {
    start: status("swap", { phase: "l2_mined" }),
  },
  "status-awaiting-proven": {
    start: status("swap", { phase: "awaiting_proven" }),
  },
  "status-finalizing": {
    start: status("swap", { phase: "finalizing_l1" }),
  },
  "status-swapping": {
    start: status("swap", { phase: "swapping" }),
  },
  "withdraw-journey": {
    start: journey,
  },
  "status-bridging": {
    start: status("bridge", { phase: "bridging" }),
  },
  "done": {
    start: status("swap", { phase: "done" }),
  },
  "done-bridge": {
    start: status("bridge", { phase: "done" }),
  },
  "done-dai": {
    start: status("direct", { phase: "done" }),
  },
  "failed": {
    start: status("direct", { phase: "failed" }),
  },
  "recoverable": {
    start: status("swap", { phase: "recoverable" }),
  },
}

/** Answers like the speed estimator after a short wait: Fast, none, never, or a failure. */
function speedLoader(speed: Speed): LoadFasterWithdrawal {
  return async () => {
    if (speed === "loading") return new Promise(() => {})
    await delay(600)
    if (speed === "failed")
      throw new WalletError("withdrawal.failed", "mock: speed estimate unavailable")
    const estimate = {
      epoch: 1,
      checkpointIndex: 3,
      standardEtaSeconds: STANDARD_ETA_SECONDS,
      tippedEtaSeconds: FAST_ETA_SECONDS,
      speedupSeconds: STANDARD_ETA_SECONDS - FAST_ETA_SECONDS,
      worstSpeedupSeconds: STANDARD_ETA_SECONDS - FAST_ETA_SECONDS,
      confidence: "measured",
      pastTipCutoff: false,
    } as unknown as WithdrawalSpeedupEstimate
    return {
      estimate,
      quote: {
        proverTip: speed === "none" ? 0n : TIP,
        gasPriceWei: 2_000_000_000n,
        usdPerEth: USD_PER_ETH * 10n ** 8n,
        subsidy: 0n,
      },
    }
  }
}

/**
 * A route's quote at once: $0.10 plus the tip, $0.12 more with a gas share, and a swap that loses
 * 0.85 DAI at $3,000 an ETH.
 */
export function mockSwapQuote({
  receiveAsset,
  amountAtomic,
  proverTip = 0n,
  daiForGas = 0n,
}: {
  receiveAsset: WithdrawalReceiveAsset
  amountAtomic?: bigint
  proverTip?: bigint
  daiForGas?: bigint
}): SwapQuote {
  const direct = receiveAsset === "DAI" && daiForGas === 0n
  const gasTip = daiForGas > 0n ? GAS_SWAP_TIP : 0n
  const floorAtomic = BASE_FEE + proverTip + gasTip
  const fee = direct
    ? {
        withdrawalFee: BASE_FEE - WITHDRAW_RELAYER_TIP,
        withdrawalRelayerTip: WITHDRAW_RELAYER_TIP,
        swapRelayerTip: 0n,
        proverTip,
        floorAtomic,
      }
    : {
        withdrawalFee: 0n,
        withdrawalRelayerTip: dai("0.05"),
        swapRelayerTip: dai("0.05") + gasTip,
        proverTip,
        floorAtomic,
      }
  if (amountAtomic === undefined || amountAtomic <= 0n) return { fee }
  if (direct)
    return {
      fee,
      estimate: { amountOut: amountAtomic, decimals: DEFAULT_DECIMALS },
    }
  const funds = amountAtomic - floorAtomic - daiForGas - SWAP_COST
  if (funds <= 0n) return { fee }
  const gasOut = daiForGas > 0n ? daiForGas / USD_PER_ETH : undefined
  const estimate =
    receiveAsset === "ETH"
      ? { amountOut: funds / USD_PER_ETH, decimals: 18, gasOut }
      : receiveAsset === "DAI"
      ? { amountOut: funds, decimals: DEFAULT_DECIMALS, gasOut }
      : { amountOut: funds / 10n ** 12n, decimals: 6, gasOut }
  return { fee, estimate }
}

/** A bridge-out quote after a short wait: $0.10 plus the tip off the amount. */
export async function mockQuoteBridgeOut(args: {
  chainId: number
  token: BridgeOutToken
  amount: bigint
  proverTip?: bigint
}): Promise<BridgeOutPriced> {
  await delay(500)
  return bridgeQuote(args.amount, args.proverTip ?? 0n, bridgeOutDecimals(args.token, args.chainId))
}

/** What the reads say about `address`; the recipient's per the mock, the others' fixed. */
function readsOf(def: MockDef) {
  const reads = new Map<string, AddressReads>([
    [RECIPIENT.toLowerCase(), READS[def.reads ?? "fresh"]],
    [LEDGER.toLowerCase(), READS.fresh],
    [ETHERFI.toLowerCase(), { ...READS.etherfi, etherfi: def.etherfi ?? "confirmed" }],
  ])
  return (address: string): AddressReads => reads.get(address.toLowerCase()) ?? READS.fresh
}

const never = <T>() => new Promise<T>(() => {})

/** The mock named `name`; undefined for no such mock. */
export function withdrawMock(name: string, config: WebWalletConfig): DemoMock | undefined {
  const def = WITHDRAW_MOCKS[name as WithdrawMockName]
  if (!def) return undefined
  const routes = def.noBridge ? [] : bridgeOutChains(config, demoAcrossExit(), DEMO_OXIDE_TUPLE)
  const reads = readsOf(def)
  const loaders: Partial<PageLoaders> = {
    bridgeOutRoutes: async () => routes,
    bridgeOutQuote: (_facts, ask) => mockQuoteBridgeOut(ask),
    l1AddressActivity: (address) => {
      const { activity } = reads(address)
      return activity ? Promise.resolve(activity) : never()
    },
    etherfiVerdict: (address) => {
      const { etherfi } = reads(address)
      return etherfi === "checking" ? never() : Promise.resolve({ kind: etherfi })
    },
    screening: (address) => {
      const { screening } = reads(address)
      if (screening === "screening") return never()
      if (screening === "error")
        return Promise.reject(new WalletError("unknown", "mock: screening unavailable"))
      return Promise.resolve(screening === "compliant" ? { compliant: true } : { compliant: false })
    },
    ensAddress: async (text) => (text.toLowerCase() === ENS_NAME ? RECIPIENT : null),
    swapQuote: {
      simulate: async ({ output, amountAtomic, proverTip, daiForGas }) =>
        mockSwapQuote({ receiveAsset: output, amountAtomic, proverTip, daiForGas }),
      executor: async () => ({ fee: BASE_FEE - WITHDRAW_RELAYER_TIP }),
    },
    fasterOffer: speedLoader(def.speed ?? "ready"),
  }
  return {
    connected: false,
    balance: def.balance ? dai(def.balance) : BALANCE,
    loaders,
    async seed(session) {
      await seedSavedWallets(session, [
        ...(def.saved ? SAVED : []),
        ...(def.savedEtherfi ? [SAVED_ETHERFI] : []),
      ])
      await seedLocal(session, READS[def.reads ?? "fresh"])
      const start = def.start?.(routes, config.l1ChainId)
      if (!start) return {}
      const { signing, record, journey, ...rest } = start
      const create = (r: WithdrawalRecord) =>
        session.withdrawals.create({ ...r, networkId: DEMO_NETWORK_ID })
      if (record) await create(record)
      const prompt = memoryStore(!!signing)
      const played = journey?.map(({ at, signing, record: next }) => ({
        at,
        run: async () => {
          prompt.set(!!signing)
          if (!next) return
          const saved = await session.withdrawals.get(next.localId)
          if (saved) await session.withdrawals.apply(next.localId, { type: "patch", fields: next })
          else await create(next)
        },
      }))
      if (played) playJourney(session.page.pace, played)
      const status = rest.history?.includes("status")
      return { withdraw: { ...rest, ...(status && { signing: prompt.readonly }) } }
    },
  }
}

/** What this wallet did with the recipient: two withdrawals to it, or a deposit it funded. */
async function seedLocal(session: Session, reads: AddressReads) {
  if (reads.local === "linked-deposit")
    await session.contacts?.upsertL1WalletContact({
      name: "Rainbow",
      address: RECIPIENT,
      provider: "manual",
      walletName: "Rainbow",
      provenance: "deposit-attested",
    })
  if (reads.local !== "withdrew-before") return
  const past = sentPlan("direct", [], 0)
  for (const localId of ["wdraw_past_1", "wdraw_past_2"])
    await session.withdrawals.create({
      ...sentRecord(past, "done"),
      localId,
      networkId: DEMO_NETWORK_ID,
    })
}
