import { useId, useState } from "react"
import { formatUnits } from "viem"
import { GradientText, TopNavIconButton } from "@obsidion/web-ds"
import { InfoButton } from "../InfoButton/InfoButton"
import { Modal } from "../Modal"
import { DepositFact } from "../screens/DepositFact"
import { usdFigure } from "../format"
import { useMediaQuery } from "../usePhoneLayout"
import copy from "./FeeBreakdown.copy"
import styles from "./FeeBreakdown.module.css"

export interface FeeRow {
  label: string
  value: string
}

/**
 * A fee's rows in dollars, from dollar amounts in `decimals`: `label` takes the rest, so the rows
 * add up to the total in cents.
 */
export function breakdown(
  label: string,
  totalAtomic: bigint,
  others: [string, bigint][],
  decimals: number,
): FeeRow[] {
  const cent = 10n ** BigInt(decimals - 2)
  const cents = (atomic: bigint) => (atomic + cent / 2n) / cent
  const shown = others.filter(([, value]) => value > 0n)
  const rest = shown.reduce((sum, [, value]) => sum - value, totalAtomic)
  const restCents = shown.reduce((sum, [, value]) => sum - cents(value), cents(totalAtomic))
  return [
    ...(rest > 0n
      ? [{ label, value: usdFigure(formatUnits(restCents > 0n ? restCents : 0n, 2)) }]
      : []),
    ...shown.map(([name, value]) => ({
      label: name,
      value: usdFigure(formatUnits(value, decimals)),
    })),
  ]
}

/**
 * The fee's info icon: hovering or focusing it shows what the fee is made of, and on a device
 * that cannot hover a tap opens it as a sheet.
 */
export function FeeInfoButton({
  rows,
  total,
  testId,
}: {
  rows: FeeRow[]
  total: string
  testId: string
}) {
  const id = useId()
  const touch = useMediaQuery("(hover: none)")
  const [open, setOpen] = useState(false)
  const close = () => setOpen(false)
  if (touch)
    return (
      <>
        <InfoButton label={copy.info} testId={testId} outline onClick={() => setOpen(true)} />
        {open && (
          <Modal
            variant="bare"
            label={copy.title}
            className="ww-deposit-warning ww-deposit-sheet"
            onClose={close}
          >
            <div className="ww-deposit-warning__close">
              <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={close} />
            </div>
            <div className="ww-deposit-sheet__head">
              <GradientText size={24} weight={700}>
                {copy.title}
              </GradientText>
            </div>
            <div className="ww-sheet__facts">
              {rows.map((row) => (
                <DepositFact key={row.label} label={row.label}>
                  <b>{row.value}</b>
                </DepositFact>
              ))}
              <hr className="ww-divider" />
              <DepositFact label={copy.total}>
                <b>{total}</b>
              </DepositFact>
            </div>
            <button
              type="button"
              className="zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost"
              onClick={close}
            >
              {copy.close}
            </button>
          </Modal>
        )}
      </>
    )
  return (
    <span className={styles.info}>
      <InfoButton label={copy.info} testId={testId} outline describedBy={id} />
      <span id={id} className={styles.pop} role="tooltip">
        {rows.map((row) => (
          <span key={row.label} className={styles.row}>
            {row.label}
            <b>{row.value}</b>
          </span>
        ))}
        <hr className="ww-divider" />
        <span className={styles.row}>
          {copy.total}
          <b>{total}</b>
        </span>
      </span>
    </span>
  )
}
