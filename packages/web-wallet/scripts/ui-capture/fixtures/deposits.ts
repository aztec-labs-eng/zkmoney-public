import * as actual from "../../../src/features/deposit/sipaGateway"
import { quotedDepositFee } from "@obsidion/core/constants"
import { formatUnits } from "viem"
import { DEMO_L1_TOKEN } from "../../../src/dev/demoFixtures"
import { DEMO_DEPOSIT_FEE, DEMO_FPC_FUNDING_CUT } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, operation, pause } from "./control"
import { SIPA, TX_HASH } from "./data"
export * from "../../../src/features/deposit/sipaGateway"

const address = { address: SIPA, name: "demo.sandbox.oxide" }
let gateway: actual.SipaDepositGateway | undefined
export const getSipaDepositGateway: typeof actual.getSipaDepositGateway = () => {
  const real = actual.getSipaDepositGateway()
  if (!fixtureState()) return real
  gateway ??= {
    depositAddress: async (_wallet, _contracts, _tag, opts) => {
      opts?.onStage?.("resolving")
      await operation("deposit-address")
      return address
    },
    pooledDepositAddress: async () => { await pause(300); return address },
    deposit: async (params) => {
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
    depositFee: async () => formatUnits(quotedDepositFee(DEMO_DEPOSIT_FEE, DEMO_FPC_FUNDING_CUT), 18),
    records: () => real.records(), subscribe: (listener) => real.subscribe(listener),
    sync: (...args) => real.sync(...args),
    nextSelfNonce: () => { throw new Error("Unmocked SIPA nonce allocation in a UI capture") },
    broadcastResolvedSipa: () => { throw new Error("Unmocked SIPA broadcast in a UI capture") },
  }
  return gateway
}
