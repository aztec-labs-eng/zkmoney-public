import { encodeFunctionData, erc20Abi, type Hex } from "viem"
import type {
  BridgeInProvider,
  BridgeInQuote,
  BridgeInQuoteRequest,
  BridgeInStatus,
} from "@obsidion/front-core"

/** Pays the bridge-in sent in `originTxHash`; `undefined` if it knows no such bridge-in. */
export type FakeFill = (originTxHash: Hex) => Promise<Hex | undefined>

const FAKE_FEE = 10_000n

/** The demo's bridge: the origin call is a plain transfer, and the first status read fills it. */
export class FakeBridgeIn implements BridgeInProvider {
  private readonly fills = new Map<Hex, Hex>()

  constructor(private readonly fill: FakeFill, private readonly now: () => number) {}

  async quote(request: BridgeInQuoteRequest): Promise<BridgeInQuote> {
    const outputAmount = request.outputAmount ?? request.inputAmount - FAKE_FEE
    return {
      inputAmount: outputAmount + FAKE_FEE,
      maxInputAmount: outputAmount + FAKE_FEE,
      outputAmount,
      expectedOutputAmount: outputAmount,
      fee: FAKE_FEE,
      fillSeconds: 5,
      expiresAt: this.now() + 5 * 60_000,
      txs: [
        {
          chainId: request.originChainId,
          to: request.inputToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "transfer",
            args: [request.recipient, outputAmount + FAKE_FEE],
          }),
        },
      ],
    }
  }

  async status(_originChainId: number, originTxHash: Hex): Promise<BridgeInStatus | undefined> {
    const fillTxHash = this.fills.get(originTxHash) ?? (await this.fill(originTxHash))
    if (!fillTxHash) return undefined
    this.fills.set(originTxHash, fillTxHash)
    return { status: "filled", fillTxHash }
  }
}

const DEMO_FILL = `0x${"d".repeat(64)}` as const
/** The demo's seeded bridge-in that never fills, so its pending row stays. */
export const DEMO_PENDING_BRIDGE_IN = `0x${"b1".repeat(32)}` as const

/** The demo page's bridge: every bridge-in fills but the seeded pending one. */
export const demoBridgeIn = (now: () => number) =>
  new FakeBridgeIn(async (hash) => (hash === DEMO_PENDING_BRIDGE_IN ? undefined : DEMO_FILL), now)
