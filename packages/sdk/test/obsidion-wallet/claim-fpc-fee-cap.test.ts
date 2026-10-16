import { NO_FROM } from "@aztec/aztec.js/account"
import { Fr } from "@aztec/aztec.js/fields"
import { GasFees } from "@aztec/stdlib/gas"
import { ExecutionPayload } from "@aztec/stdlib/tx"
import { expect, it } from "vitest"
import {
  CLAIM_FPC_MAX_FEES_PER_GAS as CAP,
  claimFpcSponsoredFee,
} from "../../src/feePaymentMethod/claimFpcBatchGas.js"
import { claimFpcRefuelFee } from "../../src/feePaymentMethod/claimFpcRefuel.js"
import { KIND_BY_ANY, buildClaimFpcPolicy } from "../../src/feePaymentMethod/claimSponsoredCall.js"
import { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import { stubSimulateTx } from "../utils/stubSimulateTx.js"

const byAny = { kind: KIND_BY_ANY, target: Fr.ZERO, selector: Fr.ZERO, max_fee: 1n }
const sponsored = claimFpcSponsoredFee(await buildClaimFpcPolicy([byAny]), [])

function walletAt(minFees: GasFees): any {
  const info = { l1ChainId: 1, rollupVersion: 1, txsLimits: { gas: { daGas: 1e6, l2Gas: 1e7 } } }
  const node = { getPredictedMinFees: async () => [minFees], getNodeInfo: async () => info }
  const pxe = { sync: async () => {}, getSyncedBlockHeader: async () => ({}) }
  return new ObsidionWallet(pxe as any, node as any)
}

async function estimatedAndSentMaxFees(minFees: GasFees, fee: object): Promise<GasFees[]> {
  const wallet = walletAt(minFees)
  const declared: GasFees[] = []
  wallet.simulateViaEntrypoint = async (_: unknown, { feeOptions }: any) => {
    declared.push(feeOptions.gasSettings.maxFeesPerGas)
    return stubSimulateTx()
  }
  wallet.buildSendRequest = async (_: unknown, __: unknown, feeOptions: any) => {
    declared.push(feeOptions.gasSettings.maxFeesPerGas)
    throw new Error("sent")
  }
  const payload = new ExecutionPayload([{} as any], [], [], [])
  await expect(wallet.sendTx(payload, { from: NO_FROM, fee })).rejects.toThrow("sent")
  return declared
}

it.each([
  ["a sponsored batch at a high min fee", sponsored, CAP],
  ["a sponsored batch at a low min fee", sponsored, new GasFees(1n, 1n)],
  ["a refuel at a high min fee", claimFpcRefuelFee(), CAP],
])("%s declares the config fee-per-gas", async (_, fee, minFees) => {
  expect(await estimatedAndSentMaxFees(minFees, fee)).toEqual([CAP, CAP])
})

it.each([
  ["at the config fee-per-gas", CAP, false],
  ["above it", new GasFees(CAP.feePerDaGas, CAP.feePerL2Gas + 1n), true],
])("sponsoredFeesAboveCap with a min fee %s is %s", async (_, minFees, above) => {
  expect(await walletAt(minFees).sponsoredFeesAboveCap()).toBe(above)
})
