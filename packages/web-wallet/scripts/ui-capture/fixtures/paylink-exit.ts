import * as actual from "../../../src/features/paylink/paylinkExit"
import { formatUnits } from "viem"
import { demoEscrowAmount } from "../../../src/dev/demoFixtures"
import { DEMO_FPC_FUNDING_CUT } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, pause } from "./control"
import { TOKEN_INFO } from "./data"
import { captureWithdrawal } from "./withdraw"
export * from "../../../src/features/paylink/paylinkExit"
export const linkVoucherUses: typeof actual.linkVoucherUses = async (...args) => {
  const state = fixtureState()
  if (!state) return actual.linkVoucherUses(...args)
  if (state === "loading") return new Promise(() => {})
  await pause()
  return state === "no-voucher" ? 0 : 1
}
export const cashOutLink: typeof actual.cashOutLink = async (...args) => {
  if (!fixtureState()) return actual.cashOutLink(...args)
  const [deps, fragment, recipient, stage] = args
  const verdict = await deps.screener.screen(recipient)
  if (!verdict.compliant) throw new Error("This address cannot receive withdrawals")
  // The link's whole escrow is burned; the recipient is paid what the fees leave.
  const gross = demoEscrowAmount(fragment)
  const amount = formatUnits(actual.cashOutNet(gross, DEMO_FPC_FUNDING_CUT), TOKEN_INFO.decimals)
  const identity = actual.linkWithdrawalIdentity(fragment)
  return captureWithdrawal(
    recipient,
    amount,
    stage,
    { source: "paylink", paylinkId: identity.id, rawAmount: gross.toString() },
    false,
    "paylink-claim-l1",
  )
}
