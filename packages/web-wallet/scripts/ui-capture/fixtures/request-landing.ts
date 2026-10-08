import * as actual from "../../../src/features/requests/accountlessRequest"
import { buildErc20TransferUri, buildErc20TransferUriWithoutAmount } from "../../../src/features/requests/eip681"
import { DEMO_L1_TOKEN } from "../../../src/dev/demoFixtures"
import { fixtureState, pause } from "./control"
import { SIPA } from "./data"
export * from "../../../src/features/requests/accountlessRequest"
let attempts = 0
export const resolveAccountlessRequest: typeof actual.resolveAccountlessRequest = async (packet, deps) => {
  const state = fixtureState()
  if (!state) return actual.resolveAccountlessRequest(packet, deps)
  attempts += 1
  await pause()
  if (state === "terminal") throw new Error("@ada is no longer registered")
  if (state === "failure" || (state === "retry" && attempts === 1)) throw new Error("The payment address could not be prepared. Try again.")
  const feeAtomic = 1_000_000_000_000_000_000n
  const grossAtomic = packet.amountAtomic > 0n ? packet.amountAtomic + feeAtomic : 0n
  const uri = { token: DEMO_L1_TOKEN, chainId: deps.chainId, to: SIPA }
  return { sipaAddress: SIPA, token: DEMO_L1_TOKEN, decimals: 18, feeAtomic, grossAtomic,
    paymentUri: grossAtomic > 0n ? buildErc20TransferUri({ ...uri, rawAmount: grossAtomic }) : buildErc20TransferUriWithoutAmount(uri),
    ...(state === "warning" ? { tagWarning: "@ada no longer matches the address on this request" } : {}),
  }
}
