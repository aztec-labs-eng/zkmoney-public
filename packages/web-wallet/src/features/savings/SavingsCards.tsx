import { Icon } from "@obsidion/web-ds"

/** Under Home's card on the Savings account: the calculator, then what it earns on. The rate lives in the APY pill above. */
export function SavingsCards({ onCalculator }: { onCalculator: () => void }) {
  return (
    <>
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-savings__card ww-savings__calc"
        onClick={onCalculator}
      >
        <div className="ww-savings__token">
          <span className="ww-savings__glyph ww-savings__glyph--calc" aria-hidden>
            <Icon name="calculator" size={18} />
          </span>
          <span>
            <b>Earnings calculator</b>
            <small>See what your savings could grow to</small>
          </span>
          <Icon name="chevron-right" size={16} />
        </div>
      </button>
      <section className="ww-savings__card">
        <h3>You're earning on</h3>
        <div className="ww-savings__token">
          <span className="ww-savings__glyph" aria-hidden>
            $
          </span>
          <span>
            <b>USDS · Sky Savings Rate</b>
            <small>Dollar stablecoin issued by Sky</small>
          </span>
        </div>
      </section>
    </>
  )
}
