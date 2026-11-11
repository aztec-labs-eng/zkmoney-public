import { useEffect, useState } from "react"
import {
  type PendingRegistrationRecord,
  type SipaDeposit,
  WalletError,
  serviceStatus,
  useStore,
} from "@obsidion/front-core"
import { errorCopy, errorMessage } from "../../../errors/catalog"
import { tokenDecimalsForNetwork } from "@obsidion/core/constants"
import { PrimaryGradientButton } from "@obsidion/web-ds"
import { DepositExitModal } from "../../deposit/DepositExitModal/DepositExitModal"
import { isGateCancelled, useCeremonyGate } from "../../identity/ceremonyGate"
import { GateStep } from "../../identity/PhoneSteps"
import { PasskeyRefusal, type RefusalState } from "../../identity/PasskeyRefusal"
import { isPasskeyCancelled, isPasskeyPolicyError } from "@obsidion/passkey-web"
import type { OnboardingKeys } from "../../../session/account"
import { reusePasskeyAccount } from "../../identity/passkeyAccount"
import { reloadIfSessionSwitched } from "../../../session/sessionReload"
import { useRegistrationRefunded } from "../../registration/registrationRecovery"
import { askedTotal } from "../../registration/registrationAsk"
import { formatDepositDue } from "../../registration/depositAmounts"
import { useSession, signedInAccount } from "../../../session/session"
import copy from "./RegistrationRefundAction.copy"
import { fmt } from "../../../lib/fmt"

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
  const session = useSession()
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const { gate, state, cancel } = useCeremonyGate()
  const recovered = useRegistrationRefunded(record)
  const restart = !holdsFunds && (recovered || unfunded)
  const earnedAsk = formatDepositDue(
    askedTotal("earned_tag"),
    tokenDecimalsForNetwork(session.page.config.network),
  )
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => cancel, [cancel])
  const [deposit, setDeposit] = useState<SipaDeposit>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<RefusalState>()
  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    setRefusal(undefined)
    try {
      if (!walletBuilt) throw new WalletError("wallet.notReady")
      const obsidionWallet = await session.wallet.ready()
      const keys = await reusePasskeyAccount(
        obsidionWallet,
        { session, accounts: () => signedInAccount(session) },
        record.l2Address,
        undefined,
        gate,
      )
      if (reloadIfSessionSwitched(session, record.l2Address)) return
      if (restart) await onRestart(keys)
      else setDeposit(await session.registrationRecovery.prepare(record, obsidionWallet.networkId))
    } catch (err) {
      if (isGateCancelled(err) || isPasskeyCancelled(err)) return
      if (isPasskeyPolicyError(err)) setRefusal({ name: err.name, message: errorMessage(err) })
      else setError(errorCopy(err) ?? copy.failed)
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
    <section aria-label={copy.label}>
      <p>
        {unfunded
          ? fmt(copy.unfunded, { price: earnedAsk })
          : restart
          ? fmt(copy.restart, { price: earnedAsk })
          : fmt(copy.recover, { price: earnedAsk })}
      </p>
      {refusal ? (
        <PasskeyRefusal error={refusal} onRetry={() => void run()} />
      ) : (
        <PrimaryGradientButton
          title={busy ? copy.preparing : restart ? copy.register : copy.recoverAction}
          isDisabled={busy}
          onClick={() => void run()}
        />
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
