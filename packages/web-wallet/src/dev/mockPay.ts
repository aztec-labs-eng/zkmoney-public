/**
 * Dev `/dev/mock/pay/<name>[?tag=<payee>][&network=<slug|chainId>][&coin=<symbol>]`: the pay
 * page's flow, or its bridge screens, for a $25 request on fakes: the resolved address, a connected
 * wallet, the bridge quotes and the bridge's status.
 */
import { parseUnits, type Hex } from "viem"
import type { RequestInlinePacket } from "@obsidion/front-core"
import type { WebWalletConfig } from "../config/env"
import { buildErc20TransferUri } from "../features/requests/eip681"
import type { AccountlessResolveResult } from "../features/requests/accountlessRequest"
import { holdPayment } from "../features/requests/unresolvedPayment"
import { DEMO_L1_TOKEN } from "./fakeL1Rpc"
import { chainFor, type DemoMock } from "./demoMock"
import type { PayMockName } from "../app/devRoutes"
import {
  mockBridgeIn,
  mockBridgeRecord,
  originLoaders,
  SIPA,
  type BridgeStatus,
} from "./mockDeposit"

const REQUESTED = parseUnits("25", 18)
const FEE = parseUnits("1", 18)
/** The request's token: a bridge-in that pays it bridges the same token. */
const LANDING = { symbol: "DAI", decimals: 18 }
/** The request's $26 gross lands from about 26.03 on the origin chain at the fake bridge's 0.1%. */
const BRIDGED = { input: "26.03", output: "26", fee: "0.03" }
const PAYEE = "brave-otter-42"
const REQUEST_ID = `0x00${"5a".repeat(31)}` as Hex

interface MockDef {
  bridge?: { step: "amount" | "progress" | "status"; sending?: boolean; status?: BridgeStatus }
  /** A payment from this browser may still land. */
  unresolved?: boolean
}

export const PAY_MOCKS: Record<PayMockName, MockDef> = {
  "pay-sheet": {},
  "pay-unresolved": {
    unresolved: true,
  },
  "pay-bridge-amount": {
    bridge: { step: "amount" },
  },
  "pay-bridge-review": {
    bridge: { step: "progress" },
  },
  "pay-bridge-approving": {
    bridge: { step: "progress", sending: true },
  },
  "pay-bridge-pending": {
    bridge: { step: "status", status: "pending" },
  },
  "pay-bridge-filled": {
    bridge: { step: "status", status: "filled" },
  },
  "pay-bridge-failed": {
    bridge: { step: "status", status: "failed" },
  },
  "pay-bridge-expired": {
    bridge: { step: "status", status: "expired" },
  },
  "pay-bridge-refunded": {
    bridge: { step: "status", status: "refunded" },
  },
}

/** The mock named `name`; undefined for no such mock. */
export function payMock(
  name: string,
  query: URLSearchParams,
  config: WebWalletConfig,
): DemoMock | undefined {
  const def = PAY_MOCKS[name as PayMockName]
  if (!def) return undefined
  const tag = query.get("tag")?.toLowerCase() ?? PAYEE
  const request: RequestInlinePacket = {
    requestId: REQUEST_ID,
    requesterTag: tag,
    amountAtomic: REQUESTED,
    tokenSymbol: "DAI",
    tokenDecimals: 18,
    networkId: "",
  }
  const resolved: AccountlessResolveResult = {
    sipaAddress: SIPA,
    token: DEMO_L1_TOKEN,
    decimals: 18,
    feeAtomic: FEE,
    grossAtomic: REQUESTED + FEE,
    paymentUri: buildErc20TransferUri({
      token: DEMO_L1_TOKEN,
      chainId: config.l1ChainId,
      to: SIPA,
      rawAmount: REQUESTED + FEE,
    }),
    deployment: "active",
  }
  const chainId = chainFor(query.get("network"), true, config)
  const symbol = query.get("coin")?.toUpperCase() ?? LANDING.symbol
  return {
    connected: true,
    // Every status read finds the bridge still pending, so nothing reads an origin chain.
    bridgeInProvider: {
      ...mockBridgeIn(config, Date.now),
      status: async () => ({ status: "pending" }),
    },
    loaders: { ...originLoaders(config), accountlessRequest: async () => resolved },
    async seed(session) {
      const { page } = session
      if (def.unresolved) await holdPayment(page.database, config.network, SIPA, "mock")
      const status = def.bridge?.status
      const record =
        status &&
        (await session.bridgeIns.rebuild({
          ...mockBridgeRecord(chainId, symbol, LANDING, status, page.now(), BRIDGED),
          pays: { payee: tag, requestId: REQUEST_ID },
        }))
      return {
        pay: {
          request,
          bridge: def.bridge && {
            step: def.bridge.step,
            sending: def.bridge.sending,
            sent: record ? record.id : undefined,
          },
          origin: def.bridge && { chainId, symbol },
        },
      }
    },
  }
}
