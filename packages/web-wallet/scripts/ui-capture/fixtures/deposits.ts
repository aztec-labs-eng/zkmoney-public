import * as actual from "../../../src/features/deposit/sipaGateway"
import { quotedDepositFee } from "@obsidion/core/constants"
import { formatUnits } from "viem"
import { DEMO_L1_TOKEN } from "../../../src/dev/demoFixtures"
import { DEMO_DEPOSIT_FEE, DEMO_FPC_FUNDING_CUT } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, operation, pause } from "./control"
import { SIPA, TX_HASH } from "./data"
import { desktopState, nextPooledAddress, sendUnresolved } from "./desktop"
import { DesktopSendUnresolvedError } from "../../../src/platform/desktopBridge"
export * from "../../../src/features/deposit/sipaGateway"

const address = { address: SIPA, name: "demo.sandbox.oxide" }
/** The helper's submission id for a send to `target`: 32 hex characters, the same for every approval of that send. */
const submissionFor = (target: string) => target.slice(2, 34).toLowerCase()
let gateway: actual.SipaDepositGateway | undefined
export const getSipaDepositGateway: typeof actual.getSipaDepositGateway = () => {
  const real = actual.getSipaDepositGateway()
  if (!fixtureState()) return real
  gateway ??= {
    depositAddress: async (_wallet, _contracts, _tag, opts) => {
      if (desktopState()) {
        await pause(300)
        return { ...address, address: nextPooledAddress() }
      }
      opts?.onStage?.("resolving")
      await operation("deposit-address")
      return address
    },
    wakeDeposit: async () => {},
    deposit: async (params) => {
      if (desktopState()) {
        // The helper approved the send, then no hash arrived: the browser wallet may still send it.
        const feeDisplay = await gateway!.depositFee()
        await params.preflight({ feeDisplay })
        params.onStage?.("awaiting-browser")
        await pause()
        // The helper page's recheck, then its approval, in the real bridge's order.
        await params.preflight({ feeDisplay })
        await params.beforeApprove?.(submissionFor(params.target.address))
        sendUnresolved(params.target.address)
        throw new DesktopSendUnresolvedError(new Error("Capture: approved without a hash"))
      }
      params.onStage?.("connecting")
      await operation("deposit")
      params.onStage?.("sending")
      await pause()
      params.onSubmitted?.(TX_HASH as `0x${string}`)
      params.onStage?.("confirming")
      await pause(2000)
      return { ...address, txHash: TX_HASH as `0x${string}` }
    },
    tokenMeta: async () => ({ address: DEMO_L1_TOKEN, symbol: "DAI", decimals: 18 }),
    depositFee: async () =>
      formatUnits(quotedDepositFee(DEMO_DEPOSIT_FEE, DEMO_FPC_FUNDING_CUT), 18),
    records: () => real.records(),
    subscribe: (listener) => real.subscribe(listener),
    sync: (...args) => real.sync(...args),
    nextSelfNonce: () => {
      throw new Error("Unmocked SIPA nonce allocation in a UI capture")
    },
    broadcastResolvedSipa: () => {
      throw new Error("Unmocked SIPA broadcast in a UI capture")
    },
    broadcastTxHashes: async () => new Set<string>(),
    // Captures publish nothing: every address reads as landed.
    slotExecutor: () => ({ landed: async () => true, send: async () => "0x" }),
  }
  return gateway
}
