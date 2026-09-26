/**
 * Unit tests for `resolveFeePaymentMethod` — the 3-step fee chain used by
 * paylink-flavoured dispatch sites that need a 3-step fallback
 * (`prepareDepositSubmit`, `preparePaylinkClaimSubmit`). NOT used by
 * `TokenService.sendToken` / `exitToL1Private`; see the helper's docstring
 * for the rationale.
 *
 * Chain order:
 *   1. options.sendOptions.fee.paymentMethod (caller's explicit override)
 *   2. submitContextFeePaymentMethod (router-prepared, e.g. claim/refund)
 *   3. wallet.getDefaultSendOptions(sender).fee.paymentMethod (wallet default)
 *
 * The DIVERGENT-branch test (#5) pins behavior for paylink callers that pass
 * a truthy `sendOptions` object without `fee.paymentMethod`: they reach the
 * wallet default rather than evaluating to `undefined`. No current paylink
 * caller exercises this branch, but the test guards the semantics so a
 * future regression would surface.
 */
import { describe, it, expect, vi } from "vitest"
import { AztecAddress } from "@aztec/stdlib/aztec-address"
import { resolveFeePaymentMethod } from "../../src/services/helpers/feeResolution.js"
import type { ObsidionWallet } from "../../src/obsidion/ObsidionWallet.js"
import type { FeePaymentMethod } from "@aztec/aztec.js/fee"

const explicitPm = { __tag: "explicit" } as unknown as FeePaymentMethod
const ctxPm = { __tag: "ctx" } as unknown as FeePaymentMethod
const walletPm = { __tag: "wallet" } as unknown as FeePaymentMethod

function makeWallet(defaultPm: FeePaymentMethod | undefined): ObsidionWallet {
  return {
    getDefaultSendOptions: vi
      .fn()
      .mockResolvedValue(defaultPm ? { fee: { paymentMethod: defaultPm } } : {}),
  } as unknown as ObsidionWallet
}

const sender = AztecAddress.fromBigIntUnsafe(1n)

describe("resolveFeePaymentMethod — 3-step chain", () => {
  it("returns caller-explicit paymentMethod (step 1 wins)", async () => {
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod(
      { sendOptions: { fee: { paymentMethod: explicitPm } } },
      ctxPm,
      wallet,
      sender,
    )
    expect(result).toBe(explicitPm)
    expect(wallet.getDefaultSendOptions).not.toHaveBeenCalled()
  })

  it("returns submitContext paymentMethod when no caller-explicit (step 2 wins)", async () => {
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod(undefined, ctxPm, wallet, sender)
    expect(result).toBe(ctxPm)
    expect(wallet.getDefaultSendOptions).not.toHaveBeenCalled()
  })

  it("returns wallet-default when no caller-explicit and no submitContext (step 3 wins)", async () => {
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod(undefined, undefined, wallet, sender)
    expect(result).toBe(walletPm)
    expect(wallet.getDefaultSendOptions).toHaveBeenCalledWith(sender)
  })

  it("returns undefined when all three sources are absent", async () => {
    const wallet = makeWallet(undefined)
    const result = await resolveFeePaymentMethod(undefined, undefined, wallet, sender)
    expect(result).toBeUndefined()
  })

  it("DIVERGENT branch: sendOptions={from} (truthy bag, no fee) falls through to wallet default", async () => {
    // Pre-refactor TokenService behavior: `getSendOptions(...) ?? walletDefault`
    // returned the caller's truthy bag, and `bag.fee?.paymentMethod` evaluated
    // to undefined — wallet default was NOT consulted.
    //
    // Post-refactor: the explicit check is `options.sendOptions.fee.paymentMethod`,
    // so a missing `fee` falls through to step 3.
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod(
      { sendOptions: { /* from-like bag with no fee */ } as { fee?: { paymentMethod?: FeePaymentMethod } } },
      undefined,
      wallet,
      sender,
    )
    expect(result).toBe(walletPm)
    expect(wallet.getDefaultSendOptions).toHaveBeenCalledWith(sender)
  })

  it("DIVERGENT branch with submitContext: sendOptions={from} still defers to submitContext over wallet default", async () => {
    // The claim/refund path (preparePaylinkClaimSubmit) threads a submitContext
    // fee; sendOptions without a fee should pick up the context value, not the
    // wallet default.
    const wallet = makeWallet(walletPm)
    const result = await resolveFeePaymentMethod(
      { sendOptions: {} },
      ctxPm,
      wallet,
      sender,
    )
    expect(result).toBe(ctxPm)
    expect(wallet.getDefaultSendOptions).not.toHaveBeenCalled()
  })
})
