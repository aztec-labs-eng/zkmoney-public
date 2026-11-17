import { Fragment } from "react"
import type { HoldingWords } from "../../../config/env"
import { fmtNodes } from "../../../lib/fmt"
import copy from "./SavingsTerms.copy"
import styles from "./SavingsTerms.module.css"

/** Where zk.money's own terms live. */
const ZK_MONEY_TERMS = "https://docs.zk.money/terms"

const link = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text}
  </a>
)

/** "A", "A and B", "A, B and C". */
const linkList = (terms: HoldingWords["terms"]) =>
  terms.map(({ label, url }, i) => (
    <Fragment key={url}>
      {i === 0 ? "" : i === terms.length - 1 ? copy.and : copy.comma}
      {link(url, label)}
    </Fragment>
  ))

/**
 * The acceptance a move into Savings needs before it can be confirmed: our terms and those of the
 * vault's provider, from the profile's words for it, and one box.
 */
export function SavingsTermsAccept({
  words,
  accepted,
  onChange,
}: {
  words: HoldingWords
  accepted: boolean
  onChange: (accepted: boolean) => void
}) {
  const zkMoney = link(ZK_MONEY_TERMS, copy.termsOfUse)
  return (
    <div className={styles.terms} data-testid="savings-terms">
      <p className="ww-sheet__note">
        {fmtNodes(copy.terms, {
          zkMoney,
          provider: words.provider,
          providerTerms: linkList(words.terms),
        })}
      </p>
      <label className={`ww-deposit-warning__again ${styles.accept}`}>
        <input type="checkbox" checked={accepted} onChange={(e) => onChange(e.target.checked)} />
        {copy.accept}
      </label>
    </div>
  )
}
