import { useState } from "react"
import { isAddress, type Address } from "viem"
import {
  GradientText,
  GradientToggle,
  PrimaryGradientButton,
  SettingsRow,
  TextField,
} from "@obsidion/web-ds"
import { useResource } from "@obsidion/front-core"
import { useSession } from "../../../session/session"
import { Modal } from "../../../ui/Modal"
import { DepositExitModal } from "../DepositExitModal/DepositExitModal"
import { FrozenDepositRefundModal } from "./FrozenDepositRefundModal"
import { readStrandedToken } from "./sipaRecovery"
import copy from "./StrandedRecoveryModal.copy"
import { errorMessage } from "../../../errors/catalog"

/**
 * Settings entry to recover a token left at one of this wallet's deposit addresses, for a case the
 * deposit's own row does not offer: a token sent after the deposit settled, or one no sweep accepts.
 */
export function StrandedRecoveryModal({ onClose }: { onClose: () => void }) {
  const [sipa, setSipa] = useState("")
  const [token, setToken] = useState("")
  const [previousVersion, setPreviousVersion] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string>()
  const [found, setFound] = useState<Awaited<ReturnType<typeof readStrandedToken>>>()
  const networkId = useResource(useSession().wallet)?.networkId

  if (found && "frozen" in found)
    return <FrozenDepositRefundModal found={found} onClose={onClose} />
  if (found) {
    return (
      <DepositExitModal
        record={found.record}
        reason="stranded"
        canSweep={false}
        stranded={found}
        onClose={onClose}
      />
    )
  }

  const valid = isAddress(sipa) && isAddress(token) && !!networkId
  const check = async () => {
    if (!networkId) return
    setChecking(true)
    setError(undefined)
    try {
      setFound(
        await readStrandedToken(sipa as Address, token as Address, networkId, previousVersion),
      )
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setChecking(false)
    }
  }
  const invalid = (v: string) => (v && !isAddress(v) ? copy.invalidAddress : undefined)

  return (
    <Modal variant="create" label={copy.title} onClose={onClose} className="ww-feedback">
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {copy.title}
      </GradientText>
      <p className="ww-endpoints__intro">{copy.intro}</p>
      <div className="ww-feedback__body">
        <TextField
          label={copy.depositAddress}
          placeholder={copy.placeholder}
          value={sipa}
          onChange={setSipa}
          error={invalid(sipa)}
        />
        <TextField
          label={copy.tokenAddress}
          placeholder={copy.placeholder}
          value={token}
          onChange={setToken}
          error={invalid(token)}
        />
        <SettingsRow
          label={copy.previousVersion}
          trailing={<GradientToggle isOn={previousVersion} onChange={setPreviousVersion} />}
        />
        {error && (
          <p className="ww-feedback__error" role="alert" data-testid="stranded-error">
            {error}
          </p>
        )}
      </div>
      <PrimaryGradientButton
        title={copy.next}
        isLoading={checking}
        isDisabled={!valid || checking}
        onClick={() => void check()}
      />
      <PrimaryGradientButton title={copy.cancel} buttonStyle="dark" onClick={onClose} />
    </Modal>
  )
}
