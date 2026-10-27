import { useEffect, useState } from "react"
import {
  useAztecContext,
  type PendingRegistrationRecord,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { DepositExitModal } from "../deposit/DepositExitModal"
import { isGateCancelled, useCeremonyGate } from "../identity/ceremonyGate"
import { GateStep } from "../identity/PhoneSteps"
import { PasskeyRefusal, type RefusalState } from "../identity/PasskeyRefusal"
import { isPasskeyCancelled, isPasskeyPolicyError } from "@obsidion/passkey-web"
import { reusePasskeyAccount, type OnboardingKeys } from "./oxideOnboarding"
import { prepareRegistrationRefund, useRegistrationRefunded } from "./registrationQuoteRecovery"
import { askedTotal } from "./registrationAsk"
import { formatDepositDue } from "./steps/DepositTermsRows"

/**
 * The way off an address the earned quote cannot use. A funded one is recovered first, then
 * restarted; an `unfunded` one (nothing ever reached it) is replaced outright. One that
 * `holdsFunds` again is recovered again, whatever was refunded before.
 */
export function RegistrationRefundAction({
  record,
  onRestart,
  unfunded = false,
  holdsFunds = false,
}: {
  record: PendingRegistrationRecord
  onRestart: (keys: OnboardingKeys) => Promise<void>
  unfunded?: boolean
  /** The live registration-token balance is not zero. */
  holdsFunds?: boolean
}) {
  const { obsidionWallet } = useAztecContext()
  const { gate, state, cancel } = useCeremonyGate()
  const recovered = useRegistrationRefunded(record)
  const restart = !holdsFunds && (recovered || unfunded)
  const earnedAsk = formatDepositDue(
    askedTotal("earned_tag"),
    tokenDecimalsForNetwork(getConfig().network),
  )
  useEffect(() => cancel, [cancel])
  const [deposit, setDeposit] = useState<SIPADepositRecord>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<RefusalState>()
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setRefusal(undefined)
    try {
      if (!obsidionWallet) throw new Error("The wallet is still starting. Try again in a moment.")
      const keys = await reusePasskeyAccount(obsidionWallet, record.l2Address, undefined, gate)
      if (restart) await onRestart(keys)
      else setDeposit(await prepareRegistrationRefund(record, getConfig()))
    } catch (err) {
      if (isGateCancelled(err) || isPasskeyCancelled(err)) return
      if (isPasskeyPolicyError(err)) setRefusal({ name: err.name, message: err.message })
      else setError(err instanceof Error ? err.message : "Recovery could not continue. Try again.")
    } finally {
      setBusy(false)
    }
  }
  if (deposit)
    return (
      <DepositExitModal
        record={deposit}
        reason="registration-quote"
        canSweep={false}
        onClose={() => setDeposit(undefined)}
      />
    )
  if (state.kind === "awaiting-action") return <GateStep state={state} onCancel={cancel} />
  return (
    <section aria-label="Registration refund">
      <p>
        {unfunded
          ? `Nothing was sent to this address, and its price is not the earned one. Request a new address at the earned ${earnedAsk} price, then fund that new address.`
          : restart
          ? `Your deposit was recovered. Request a new address at the earned ${earnedAsk} price, then fund that new address. Your wallet access is unchanged.`
          : `This deposit cannot complete the old registration price. Recover it to your Ethereum wallet first, then register at the earned ${earnedAsk} price. Do not send more to this address. Recovery requires ETH for gas.`}
      </p>
      {refusal ? (
        <PasskeyRefusal error={refusal} onRetry={() => void run()} />
      ) : (
        <PrimaryGradientButton
          title={busy ? "Preparing…" : restart ? "Register at earned price" : "Recover deposit"}
          isDisabled={busy}
          onClick={() => void run()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
