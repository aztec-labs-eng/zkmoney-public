import type { AztecAddress } from "@aztec/aztec.js/addresses"
import type { FeePaymentMethod } from "@aztec/aztec.js/fee"
import type { ObsidionWallet } from "../../obsidion/ObsidionWallet.js"

/**
 * Single fee-resolution chain shared by paylink-flavoured dispatch sites that
 * need a 3-step fallback. Used by:
 *
 *   - `paylinkDepositSubmit.prepareDepositSubmit` (deposit; no submitContext —
 *     2-step degenerate case).
 *   - `paylinkClaimSubmit.preparePaylinkClaimSubmit` (claim / refund; has
 *     `submitContext.feePaymentMethod` threaded from the upstream caller).
 *
 * Resolution order (first defined value wins):
 *
 *   1. `options.sendOptions.fee.paymentMethod` — caller's explicit per-call
 *      override.
 *   2. `submitContextFeePaymentMethod` — router-prepared value (claim/refund
 *      path threads `submitContext.feePaymentMethod` here, derived from the
 *      caller's own `options` upstream).
 *   3. `wallet.getDefaultSendOptions(sender).fee.paymentMethod` — wallet
 *      default fallback.
 *
 * Returns `undefined` when all three are absent; downstream code tolerates
 * `undefined` and lets the wallet pick its own default at send time.
 *
 * NOT used by `TokenService.sendToken` / `exitToL1Private`. Those paths read
 * `paymentMethod` directly from the `sendOptions` already resolved by
 * `ServiceBase.getSendOptions`, which avoids invoking
 * `wallet.getDefaultSendOptions` a second time.
 */
export async function resolveFeePaymentMethod(
  options: { sendOptions?: { fee?: { paymentMethod?: FeePaymentMethod } } } | undefined,
  submitContextFeePaymentMethod: FeePaymentMethod | undefined,
  wallet: ObsidionWallet,
  sender: AztecAddress,
): Promise<FeePaymentMethod | undefined> {
  const explicit = options?.sendOptions?.fee?.paymentMethod
  if (explicit) return explicit
  if (submitContextFeePaymentMethod) return submitContextFeePaymentMethod
  const defaultOpts = await wallet.getDefaultSendOptions(sender)
  return defaultOpts?.fee?.paymentMethod
}
