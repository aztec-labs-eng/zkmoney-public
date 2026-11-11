/**
 * Dev `/dev/mock/deposit/<name>[?network=<slug|chainId>][&coin=<symbol>]`: any view of the deposit
 * flow on fakes, no wallet, address or funds needed. This module fakes the connected wallet, the
 * saved wallets, the bridge quotes and origin reads, and seeds each view's records and start.
 */
import { parseUnits, type Address, type Hex } from "viem"
import type {
  BridgeInProvider,
  BridgeInQuote,
  BridgeInRecord,
  SIPADepositPhase,
  SipaDeposit,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../config/env"
import type { DepositStart, FundStart } from "../features/deposit/depositStart"
import type { DepositFlowStep } from "../features/deposit/DepositFlow/DepositFlow"
import type { SentDeposit } from "../features/deposit/DepositFromWalletModal/DepositFromWalletModal"
import { bridgeLanding, tokenAddress } from "../features/deposit/bridgeChains"
import { profileBridge } from "../session/walletChains"
import {
  loadDepositTokens,
  settlementDecimals,
  type DepositTokenOption,
} from "../features/sipa/loadDepositFacts"
import { DEMO_NETWORK_ID } from "./demoFixtures"
import { DEMO_L1_ACCOUNT, DEMO_L1_TOKENS, DEMO_TOKEN_DECIMALS } from "./fakeL1Rpc"
import { demoDepositAddress } from "./demoDeposit"
import { chainFor, playJourney, savedWallet, seedSavedWallets, type DemoMock } from "./demoMock"
import type { DepositMockName } from "../app/devRoutes"

export const ACCOUNT = DEMO_L1_ACCOUNT
/** The demo's deposit address: every mocked deposit pays it. */
export const SIPA = demoDepositAddress().address
const TX = `0x${"7e".repeat(32)}` as Hex

const SAVED = [
  savedWallet("Ledger", "0x2F91c6E0b8D47a3F5e2C19B0d6A8e7F43b1Da4C3"),
  savedWallet("Rabby", "0x9d4C21aB7E06f3D85c9A1e4B2f7D0c6E38a5b1E7"),
]

/** Origin-chain decimals by symbol, as the demo profile's tokens have them. */
const DECIMALS: Record<string, number> = { USDC: 6, USDT: 6, DAI: 18 }
export const decimalsOf = (symbol: string) => DECIMALS[symbol] ?? 18
/** The fake bridge takes 0.1%: $0.50 on 500. */
const BRIDGE_FEE_PER_MILLE = 1n

export type BridgeStatus = BridgeInRecord["status"]

type AddressPhase =
  | "creating"
  | "capped"
  | "ready"
  | "waiting"
  | "read-error"
  | "spotted"
  | "arrived"
  | "over-limit"

interface BridgeDef {
  step: "amount" | "progress" | "status"
  sending?: boolean
  status?: BridgeStatus
  /** The deposit the bridge paid is in the private funds. */
  landed?: boolean
  /** Plays the record from pending to filled at 4s to landed at 10s. */
  journey?: boolean
}

interface MockDef {
  connected?: boolean
  saved?: boolean
  /** The default origin: `bridge` is the first bridge chain, else the L1. */
  bridge?: boolean
  /** The origin coin unless `&coin=` names one; USDC otherwise. */
  coin?: string
  /** The deposit modal is open for this intent; `saved` opens it from the first saved wallet. */
  entry?: { intent: "wallet" | "address" | "bridge"; saved?: boolean }
  steps?: DepositFlowStep[]
  address?: AddressPhase
  aboutLimits?: DepositStart["aboutLimits"]
  held?: boolean
  amount?: string
  fund?: FundStart
  sent?: SIPADepositPhase
  /** Plays the sent deposit from funding to sweeping at 4s to claimed at 10s. */
  sentJourney?: boolean
  bridgeIn?: BridgeDef
  switching?: boolean
}

const ADDRESS_FLOW: DepositFlowStep[] = ["pick", "privacy"]
const PICK: DepositFlowStep[] = ["pick"]
const METHOD: DepositFlowStep[] = ["pick", "method"]

const fund = (phase: FundStart, extra: Partial<MockDef> = {}): MockDef => ({
  connected: true,
  entry: { intent: "wallet" },
  steps: PICK,
  amount: "500",
  fund: phase,
  ...extra,
})
const sent = (phase: SIPADepositPhase, journey?: boolean): MockDef => ({
  connected: true,
  entry: { intent: "wallet" },
  steps: PICK,
  sent: phase,
  sentJourney: journey,
})
const address = (phase: AddressPhase): MockDef => ({
  entry: { intent: "address" },
  steps: ADDRESS_FLOW,
  address: phase,
})
const bridge = (step: BridgeDef, extra: Partial<MockDef> = {}): MockDef => ({
  connected: true,
  bridge: true,
  entry: { intent: "wallet" },
  steps: PICK,
  amount: "500",
  bridgeIn: step,
  ...extra,
})

export const DEPOSIT_MOCKS: Record<DepositMockName, MockDef> = {
  "landing-empty": {},
  "landing-saved": { saved: true },
  "landing-held": {
    held: true,
  },
  "picker": {
    entry: { intent: "bridge" },
    steps: PICK,
  },
  "method": {
    entry: { intent: "bridge" },
    steps: METHOD,
  },
  "privacy": {
    entry: { intent: "address" },
    steps: ADDRESS_FLOW,
  },
  "about-limits": {
    entry: { intent: "address" },
    steps: ADDRESS_FLOW,
    aboutLimits: "limit",
  },
  "about-capacity": {
    entry: { intent: "address" },
    steps: ADDRESS_FLOW,
    aboutLimits: "capacity",
  },
  "address-creating": address("creating"),
  "address-capped": address("capped"),
  "address": address("ready"),
  "address-waiting": address("waiting"),
  "address-read-error": address("read-error"),
  "address-spotted": address("spotted"),
  "address-arrived": address("arrived"),
  "address-over-limit": address("over-limit"),
  "send-eth": fund({ phase: "form" }),
  "send-eth-over-limit": fund({ phase: "form" }, { amount: "6000" }),
  "send-eth-fee-changed": fund({
    phase: "ready",
    feeChanged: true,
  }),
  "send-eth-review": fund({ phase: "ready" }),
  "send-eth-approving": fund({
    phase: "depositing",
    stage: "sending",
  }),
  "send-eth-switching": fund({ phase: "switching" }),
  "send-eth-failed": fund({ phase: "ready" }),
  "waiting-eth": sent("funding"),
  "arrived-eth": sent("sweeping"),
  "landed-eth": sent("claimed"),
  "sent-journey": sent("funding", true),
  "deposit-failed": sent("failed"),
  "deposit-recoverable": sent("recoverable"),
  "bridge-in": bridge({ step: "amount" }),
  "bridge-review": bridge({ step: "progress" }),
  "bridging-approving": bridge({
    step: "progress",
    sending: true,
  }),
  "bridging-failed": bridge({ step: "progress" }),
  "bridging": bridge({
    step: "status",
    status: "pending",
  }),
  "bridged": bridge({
    step: "status",
    status: "filled",
  }),
  "bridge-arrived": bridge({
    step: "status",
    status: "filled",
    landed: true,
  }),
  "bridge-journey": bridge({ step: "status", status: "pending", journey: true }, { coin: "DAI" }),
  "bridge-refunded": bridge({ step: "status", status: "refunded" }),
  "bridge-expired": bridge({ step: "status", status: "expired" }),
  "bridge-not-sent": bridge({
    step: "status",
    status: "failed",
  }),
  "switch-account": {
    connected: true,
    saved: true,
    bridge: true,
    entry: { intent: "wallet", saved: true },
    steps: PICK,
    switching: true,
  },
}

/** A sent bridge-in at `status`, landing as `landing`; 500 in, 499.5 out unless `amounts` says otherwise. */
export function mockBridgeRecord(
  chainId: number,
  symbol: string,
  landing: Pick<DepositTokenOption, "symbol" | "decimals">,
  status: BridgeStatus,
  now: number,
  amounts = { input: "500", output: "499.5", fee: "0.5" },
): Omit<BridgeInRecord, "id"> {
  const unit = (amount: string, decimals: number) => parseUnits(amount, decimals).toString()
  const decimals = decimalsOf(symbol)
  const start = now - 90_000
  return {
    originTxHash: TX,
    originChainId: chainId,
    depositor: ACCOUNT,
    recipient: SIPA,
    symbol,
    inputAmount: unit(amounts.input, decimals),
    outputAmount: unit(amounts.output, landing.decimals),
    fee: unit(amounts.fee, decimals),
    inputDecimals: decimals,
    outputSymbol: landing.symbol,
    outputDecimals: landing.decimals,
    status,
    startTime: start,
    ...(status !== "pending" && { endTime: start + 60_000 }),
  }
}

/** Quotes at 0.1% with each token's decimals; never sees a bridge call, so nothing fills. */
export function mockBridgeIn(
  config: Pick<WebWalletConfig, "bridge">,
  now: () => number,
): BridgeInProvider {
  const decimals = originDecimals(config)
  const scale = (amount: bigint, from: number, to: number) =>
    to >= from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to)
  return {
    quote: async (request): Promise<BridgeInQuote> => {
      const inDecimals = decimals.get(request.inputToken.toLowerCase())?.decimals ?? 18
      const outDecimals =
        DEMO_L1_TOKENS[request.outputToken.toLowerCase()]?.decimals ?? DEMO_TOKEN_DECIMALS
      const outAsIn = request.outputAmount
        ? scale(request.outputAmount, outDecimals, inDecimals)
        : undefined
      const inputAmount = request.inputAmount ?? (outAsIn! * (1000n + BRIDGE_FEE_PER_MILLE)) / 1000n
      const fee = outAsIn !== undefined ? inputAmount - outAsIn : inputAmount / 1000n
      const outputAmount = request.outputAmount ?? scale(inputAmount - fee, inDecimals, outDecimals)
      return {
        inputAmount,
        maxInputAmount: inputAmount,
        outputAmount,
        expectedOutputAmount: outputAmount,
        fee,
        fillSeconds: 420,
        expiresAt: now() + 5 * 60_000,
        txs: [],
      }
    },
    status: async () => undefined,
  }
}

/** Each profile bridge token's symbol and decimals, by lowercase address. */
function originDecimals(config: Pick<WebWalletConfig, "bridge">) {
  const tokens = new Map<string, { symbol: string; decimals: number }>()
  for (const chain of profileBridge(config)?.chains ?? [])
    for (const token of chain.in) {
      const address = tokenAddress(token)
      if (address)
        tokens.set(address.toLowerCase(), {
          symbol: token.symbol,
          decimals: decimalsOf(token.symbol),
        })
    }
  return tokens
}

/** The origin wallet's reads: 1,240 of every coin, and each coin's decimals. */
export function originLoaders(config: Pick<WebWalletConfig, "bridge">): DemoMock["loaders"] {
  const tokens = originDecimals(config)
  const facts = (token: Address) =>
    tokens.get(token.toLowerCase()) ?? { symbol: "ETH", decimals: 18 }
  return {
    originBalance: async (_chainId, token) => parseUnits("1240", facts(token).decimals),
    originToken: async (_chainId, token) => facts(token),
  }
}

/** A sent deposit's record at `phase`, as the store would have it. */
function sentRecord(
  sent: SentDeposit,
  decimals: number,
  phase: SIPADepositPhase,
  l1ChainId: number,
  now: number,
) {
  const start = now - 4 * 60_000
  const fee = parseUnits("0.85", decimals)
  const gross = parseUnits(sent.amount, decimals)
  return {
    networkId: DEMO_NETWORK_ID,
    sipaAddress: sent.address,
    phase,
    amount: sent.amount,
    fee: fee.toString(),
    ...(phase !== "funding" && { netAmount: (gross - fee).toString() }),
    tokenSymbol: sent.tokenSymbol,
    fundingTokenSymbol: sent.tokenSymbol,
    tokenAddress: sent.tokenAddress,
    tokenDecimals: sent.tokenDecimals,
    l1ChainId,
    startTime: start,
    fundingTxHash: sent.txHash,
    fundingFromAddress: ACCOUNT,
    walletName: sent.walletName,
    walletAddress: sent.walletAddress,
    recipientL2Address: `0x${"0a".repeat(32)}`,
    messageSecret: `0x${"0b".repeat(32)}`,
    recipientHash: `0x${"0c".repeat(32)}`,
    recoveryAddress: ACCOUNT,
    ...(["claimed", "failed", "recovered"].includes(phase) && { endTime: start + 3 * 60_000 }),
    ...(phase === "claimed" && { claimedInboxIndexes: ["0"] }),
    ...(phase === "failed" && { error: "The sweep reverted on Ethereum." }),
  } as SipaDeposit & { networkId: string }
}

/** The sweep that credits a sent deposit. */
const sweepOf = (record: SipaDeposit) => ({
  inboxIndex: "0",
  sweepTxHash: `0x${"5e".repeat(32)}` as Hex,
  netAmount: record.netAmount ?? record.amount,
})

/** The mock named `name`, its origin from `?network=` and `?coin=`; undefined for no such mock. */
export function depositMock(
  name: string,
  query: URLSearchParams,
  config: WebWalletConfig,
): DemoMock | undefined {
  const def = DEPOSIT_MOCKS[name as DepositMockName]
  if (!def) return undefined
  const chainId = chainFor(query.get("network"), !!def.bridge, config)
  const symbol = query.get("coin")?.toUpperCase() ?? def.coin ?? "USDC"
  const onL1 = chainId === config.l1ChainId
  return {
    connected: !!def.connected,
    bridgeInProvider: mockBridgeIn(config, Date.now),
    // One-second slots: the arrival is the fixed pickup, sync and proof time.
    loaders: {
      ...originLoaders(config),
      slotGrid: async () => ({ l1GenesisTime: 0, slotDuration: 1 }),
    },
    async seed(session) {
      const { page } = session
      const now = page.now()
      if (def.saved) await seedSavedWallets(session, SAVED)
      if (def.held)
        await session.unresolvedSends.apply({ type: "held", send: { address: SIPA, at: now } })
      const tokens = await loadDepositTokens(page)
      const coin =
        (onL1 && tokens.offered.find((c) => c.symbol === symbol)) ||
        tokens.offered.find((c) => c.address === tokens.settlement.address) ||
        tokens.offered[0]!
      const sent: SentDeposit = {
        address: SIPA,
        txHash: TX,
        amount: "500",
        tokenSymbol: coin.symbol,
        tokenAddress: coin.address,
        tokenDecimals: coin.decimals,
        walletName: "MetaMask",
        walletAddress: ACCOUNT,
      }
      // A record's amounts are in the token it settles in.
      const decimals = settlementDecimals(tokens, coin.address) ?? coin.decimals
      const deposits = session.sipaDeposits
      const claimed = sentRecord(sent, decimals, "claimed", config.l1ChainId, now)
      if (def.sent)
        await deposits.adopt(sentRecord(sent, decimals, def.sent, config.l1ChainId, now))
      if (def.sentJourney)
        playJourney(page.pace, [
          {
            at: 4_000,
            run: () =>
              deposits.apply(SIPA, {
                type: "observed",
                fields: { phase: "sweeping", netAmount: claimed.netAmount },
              }),
          },
          {
            at: 10_000,
            run: () => deposits.apply(SIPA, { type: "claimed", sweep: sweepOf(claimed) }),
          },
        ])
      if (def.address === "arrived") await deposits.adopt(claimed)
      const bridgeIn = def.bridgeIn
      let bridgeSent: string | undefined
      const landing = bridgeLanding(tokens.offered, symbol)
      if (bridgeIn?.status && landing) {
        const record = await session.bridgeIns.rebuild(
          mockBridgeRecord(chainId, symbol, landing, bridgeIn.status, now),
        )
        bridgeSent = record?.id
        if (bridgeIn.landed) await deposits.adopt(claimed)
        if (bridgeIn.journey && record)
          playJourney(page.pace, [
            {
              at: 4_000,
              run: () =>
                session.bridgeIns.apply(record.id, [
                  {
                    type: "reported",
                    status: { status: "filled", fillTxHash: `0x${"f1".repeat(32)}` },
                    at: page.now(),
                  },
                ]),
            },
            { at: 10_000, run: () => deposits.adopt(claimed) },
          ])
      }
      const spotted =
        def.address === "spotted" || def.address === "arrived" || def.address === "over-limit"
      const start: DepositStart = {
        entry: def.entry && {
          intent: def.entry.intent,
          saved: def.entry.saved ? SAVED[0] : undefined,
        },
        steps: def.steps,
        origin: { chainId, symbol },
        address: spotted ? "spotted" : (def.address as DepositStart["address"]),
        ...(spotted && {
          funded: parseUnits(def.address === "over-limit" ? "25000" : "500", coin.decimals),
        }),
        aboutLimits: def.aboutLimits,
        amount: def.amount === undefined ? undefined : { amount: def.amount, side: "from" },
        fund: def.fund,
        sent: def.sent && sent,
        bridge: bridgeIn && { step: bridgeIn.step, sending: bridgeIn.sending, sent: bridgeSent },
        switching: def.switching,
      }
      return { deposit: start }
    },
  }
}
