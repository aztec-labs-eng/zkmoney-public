import { Icon } from "@obsidion/web-ds"
import { SavingsHoldings } from "../SavingsHoldings/SavingsHoldings"
import copy from "./SavingsCards.copy"
import styles from "./SavingsCards.module.css"

/** Under Home's card on the Savings account: what it earns on, then the calculator. */
export function SavingsCards({
  onVault,
  onCalculator,
}: {
  onVault: (holdingId: string) => void
  onCalculator: () => void
}) {
  return (
    <>
      <SavingsHoldings onOpen={onVault} />
      <button
        type="button"
        className={`zkm-btn-reset zkm-pressable ${styles.card} ${styles.calc}`}
        onClick={onCalculator}
      >
        <div className={styles.token}>
          <span className={styles.glyph} aria-hidden>
            <Icon name="calculator" size={18} />
          </span>
          <span>
            <b>{copy.calculator}</b>
            <small>{copy.calculatorNote}</small>
          </span>
          <Icon name="chevron-right" size={16} />
        </div>
      </button>
    </>
  )
}
