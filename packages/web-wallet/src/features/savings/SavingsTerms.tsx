/** Where Savings' terms live: ours, then Sky's, whose vault holds the funds. */
export const SAVINGS_TERMS = {
  zkMoney: "https://docs.zk.money/terms",
  sky: "https://docs.sky.money/legal/skybase-international/terms-of-use",
  skyRisks: "https://docs.sky.money/legal/skybase-international/user-risks",
}

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
)

/** The acceptance a move into Savings needs before it can be confirmed: the terms, and one box. */
export function SavingsTermsAccept({
  accepted,
  onChange,
}: {
  accepted: boolean
  onChange: (accepted: boolean) => void
}) {
  return (
    <div className="ww-savings__terms">
      <p className="ww-sheet__note">
        Savings is governed by zk.money's {link(SAVINGS_TERMS.zkMoney, "Terms of Use")} and Sky's{" "}
        {link(SAVINGS_TERMS.sky, "Terms of Use")} and {link(SAVINGS_TERMS.skyRisks, "User Risks")}.
        By using it, you acknowledge and agree that you have read and understood these terms and the
        risks involved.
      </p>
      <label className="ww-deposit-warning__again ww-savings__terms-accept">
        <input type="checkbox" checked={accepted} onChange={(e) => onChange(e.target.checked)} />
        Confirm you have read and accept the terms
      </label>
    </div>
  )
}
