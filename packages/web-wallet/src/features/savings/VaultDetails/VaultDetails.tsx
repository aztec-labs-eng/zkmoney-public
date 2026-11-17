import { FactBox, GradientText, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { useStore } from "@obsidion/front-core"
import { fmt } from "../../../lib/fmt"
import { Modal } from "../../../ui/Modal"
import { useSession } from "../../../session/session"
import { useActivityHost } from "../../../ui/activity/ActivityDetailHost/ActivityDetailHost"
import { HoldingLineRow } from "../HoldingLineRow/HoldingLineRow"
import { selectHoldingRows, type HoldingRowView } from "../holdingRows"
import { selectVaultSwappable } from "../savingsLine"
import { etaPhrase, moveNowEta, useSavingsMoveTiming } from "../savingsMoveTiming"
import copy from "./VaultDetails.copy"
import styles from "./VaultDetails.module.css"

/** The profile's facts about a line; how long a move back takes, once timed. */
function facts(words: NonNullable<HoldingRowView["words"]>, eta: string | undefined) {
  return [
    { label: copy.fact.yieldFrom, value: words.yieldFrom },
    {
      label: copy.fact.moveBack,
      value: eta ? fmt(copy.moveBack, { when: words.moveBack, eta }) : words.moveBack,
    },
    { label: copy.fact.risk, value: words.risk },
  ]
}

/** A Savings line's details, and the moves into and out of it. Empty once the line is gone. */
export function VaultDetails({
  holdingId,
  onAdd,
  onMoveOut,
  onClose,
}: {
  holdingId: string
  onAdd: () => void
  onMoveOut: () => void
  onClose: () => void
}) {
  const { savingsLine, device, page, vaultSwapTargets } = useSession()
  const savings = useStore(savingsLine)
  const hidden = useStore(device, (s) => s.hideBalances)
  const now = useStore(page.wallClock)
  const timing = useSavingsMoveTiming()
  const vaultSwappable = useStore(vaultSwapTargets, (targets) =>
    selectVaultSwappable(savings, targets, holdingId),
  )
  const { arriving } = useActivityHost().feed
  const row = selectHoldingRows(savings, page.config.holdingCopy, arriving.vaultSwapping).find(
    (r) => r.id === holdingId,
  )
  if (!row) return null
  const eta = timing && moveNowEta(timing, now)
  const line = <HoldingLineRow row={row} hidden={hidden} />
  return (
    <Modal
      variant="bare"
      label={copy.title}
      className={`ww-deposit-warning ${styles.sheet}`}
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={onClose} />
      </div>
      <div className={styles.title}>
        <GradientText size={22} weight={600}>
          {copy.title}
        </GradientText>
      </div>
      {row.words ? (
        <FactBox
          layout="columns"
          head={line}
          facts={facts(row.words, eta && etaPhrase(eta.seconds))}
        />
      ) : (
        line
      )}
      <div className={styles.actions} data-testid="vault-details">
        {!row.exitOnly && (
          <PrimaryGradientButton title={copy.add} testId="vault-details-add" onClick={onAdd} />
        )}
        <PrimaryGradientButton
          title={vaultSwappable ? copy.move : copy.out}
          buttonStyle="secondary"
          testId="vault-details-out"
          isDisabled={!row.held}
          onClick={onMoveOut}
        />
      </div>
    </Modal>
  )
}
